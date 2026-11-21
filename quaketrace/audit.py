"""Detect persistent changes in event-centred published timing residuals."""

from dataclasses import dataclass
from statistics import median

from .data import Arrival, AUDIT_STATIONS, BASELINE_EVENTS, EVALUATION_EVENTS

THRESHOLD_S = 1.5


@dataclass(frozen=True)
class AuditResult:
    station_id: str
    status: str
    baseline_s: float | None
    deviations_s: dict[str, float | None]
    supporting_events: tuple[str, ...] = ()
    last_normal_event: str | None = None
    estimated_offset_s: float | None = None

    @property
    def first_suspicious_event(self) -> str | None:
        return self.supporting_events[0] if self.supporting_events else None

    @property
    def confirming_event(self) -> str | None:
        return self.supporting_events[1] if len(self.supporting_events) >= 2 else None


def audit(
    arrivals: tuple[Arrival, ...],
    *,
    shifted_station: str | None = None,
    onset_event: str | None = None,
    offset_s: float = 0.0,
) -> dict[str, AuditResult]:
    """Overlay a scenario in memory, then score each station independently."""
    if offset_s and (shifted_station not in AUDIT_STATIONS or onset_event not in EVALUATION_EVENTS):
        raise ValueError("Choose an audit station and evaluation event for the shift.")
    shifted_events = (
        EVALUATION_EVENTS[EVALUATION_EVENTS.index(onset_event):] if offset_s else ()
    )
    events = BASELINE_EVENTS + EVALUATION_EVENTS
    by_event: dict[str, dict[str, float]] = {event: {} for event in events}
    for row in arrivals:
        if row.event_id in by_event and row.station_id in AUDIT_STATIONS:
            shift = offset_s if row.station_id == shifted_station and row.event_id in shifted_events else 0
            by_event[row.event_id][row.station_id] = row.residual_s + shift

    centred = {}
    for event, residuals in by_event.items():
        if len(residuals) >= 4:
            common_shift = median(residuals.values())
            centred[event] = {station: value - common_shift for station, value in residuals.items()}
        else:
            centred[event] = {}

    return {station: _score(station, centred) for station in AUDIT_STATIONS}


def _score(station: str, centred: dict[str, dict[str, float]]) -> AuditResult:
    events = BASELINE_EVENTS + EVALUATION_EVENTS
    baseline_points = [centred[event].get(station) for event in BASELINE_EVENTS]
    if any(point is None for point in baseline_points):
        return AuditResult(station, "insufficient", None, dict.fromkeys(events))
    baseline = median(baseline_points)
    deviations = {
        event: centred[event][station] - baseline if station in centred[event] else None
        for event in events
    }

    run: list[str] = []
    last_normal = next(
        (event for event in reversed(BASELINE_EVENTS) if abs(deviations[event]) < THRESHOLD_S),
        None,
    )
    run_last_normal = last_normal
    for event in EVALUATION_EVENTS:
        value = deviations[event]
        if value is None or abs(value) < THRESHOLD_S:
            if len(run) >= 2:
                break
            run.clear()
            if value is not None:
                last_normal = event
            continue
        if run and (value > 0) != (deviations[run[-1]] > 0):
            if len(run) >= 2:
                break
            run.clear()
        if not run:
            run_last_normal = last_normal
        run.append(event)

    if len(run) >= 2:
        return AuditResult(
            station, "flagged", baseline, deviations, tuple(run), run_last_normal,
            median(deviations[event] for event in run),
        )
    if run:
        return AuditResult(station, "pending", baseline, deviations, tuple(run), run_last_normal)
    return AuditResult(station, "clear", baseline, deviations, last_normal_event=last_normal)
