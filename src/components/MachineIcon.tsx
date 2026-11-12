import { Laptop, Monitor, Server } from 'lucide-react';
import type { Platform } from '../../shared/types';

/** A simple stroke icon for a machine's platform. */
export function MachineIcon({ platform, size = 16 }: { platform: Platform; size?: number }) {
  const Icon = platform === 'darwin' ? Laptop : platform === 'win32' ? Monitor : Server;
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" />;
}
