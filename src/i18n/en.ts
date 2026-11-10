/** Every string the UI shows. Components never hardcode text. */
export const en = {
  app: {
    name: 'Token Tracker for Claude Code',
    shortName: 'Token Tracker',
  },

  nav: {
    label: 'Sections',
    overview: 'Overview',
    projects: 'Projects',
    models: 'Models',
    calendar: 'Calendar',
    sessions: 'Sessions',
    agents: 'Agents',
    machines: 'Machines',
    settings: 'Settings',
  },

  pages: {
    overview: {
      title: 'Overview',
      subtitle: 'The essentials of your usage · open a section for the details',
    },
    projects: {
      title: 'Projects',
      subtitle: 'Detailed analysis of each project',
    },
    models: {
      title: 'Models',
      subtitle: 'Usage, cache and cost per model',
    },
    calendar: {
      title: 'Calendar',
      subtitle: 'When you use Claude Code',
    },
    sessions: {
      title: 'Sessions',
      subtitle: 'Size, duration and detail of your sessions',
    },
    agents: {
      title: 'Agents',
      subtitle: 'Subagents: token share, types and startup cost',
    },
    machines: {
      title: 'Machines',
      subtitle: 'Usage per computer',
    },
    settings: {
      title: 'Settings',
      subtitle: 'Sources, sync and pricing',
    },
  },

  header: {
    machineSelector: 'Machine',
    allMachines: 'All',
    periodSelector: 'Period',
    periods: {
      '7d': '7d',
      '30d': '30d',
      '90d': '90d',
      '1y': '1y',
    },
  },

  titleBar: {
    localOnly: 'Local only',
  },

  source: {
    label: 'Source:',
    sampleData: 'Sample data',
    notFound: 'No logs found yet',
  },

  placeholder: {
    title: 'Nothing to show yet',
    body: 'This section is not built yet. It will fill up with your usage data in an upcoming version.',
  },
} as const;
