import type { LiveSeries } from '../../shared/types';
import { strings } from '../i18n';

/** The name of a series: its project, or the count of projects merged into the last one. */
export function liveSeriesLabel(series: LiveSeries): string {
  return series.project ?? strings.live.chart.others(series.projects);
}
