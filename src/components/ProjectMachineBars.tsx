import type { MachineProject } from '../../shared/types';
import { formatPercent, formatTokens } from '../lib/format';
import type { MachineSeries } from './MachineWeeklyBars';

interface ProjectMachineBarsProps {
  projects: MachineProject[];
  /** One entry per value of `MachineProject.machines`, in the same order. */
  series: MachineSeries[];
  label: string;
}

/** One bar per project, cut by machine, with each machine's share written above it. */
export function ProjectMachineBars({ projects, series, label }: ProjectMachineBarsProps) {
  return (
    <ul className="project-machines" aria-label={label}>
      {projects.map((project) => {
        const parts = series
          .map((machine, index) => ({ ...machine, index, tokens: project.machines[index] ?? 0 }))
          .filter((part) => part.tokens > 0);
        const shares = parts
          .map((part) => `${part.name} ${formatPercent(part.tokens / project.tokens)}`)
          .join(' · ');
        return (
          <li key={project.name} className="project-machine">
            <div className="project-machine-head">
              <span className="project-machine-name" title={project.name}>
                {project.name}
              </span>
              <span className="project-machine-shares num" title={formatTokens(project.tokens)}>
                {shares}
              </span>
            </div>
            <div className="project-machine-bar" aria-hidden="true">
              {parts.map((part) => (
                <span
                  key={part.index}
                  className="project-machine-part"
                  style={{ flexGrow: part.tokens, background: part.color }}
                  title={`${part.name} · ${formatTokens(part.tokens)}`}
                />
              ))}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
