import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import { strings } from '../src/i18n';

/**
 * Application menu. It is visible on macOS only (the Windows title bar is custom), but its
 * accelerators work on both platforms: copy and paste, zoom, full screen, quit.
 * Every item has its own label, in the app's language: Electron would otherwise name the
 * roles in the system's language. Call it again after a change of language.
 */
export function installAppMenu(isDev: boolean): void {
  const isMac = process.platform === 'darwin';
  const m = strings.menu;

  const viewItems: MenuItemConstructorOptions[] = [
    { role: 'resetZoom', label: m.actualSize },
    { role: 'zoomIn', label: m.zoomIn },
    { role: 'zoomOut', label: m.zoomOut },
    { type: 'separator' },
    { role: 'togglefullscreen', label: m.fullScreen },
  ];
  if (isDev) {
    viewItems.unshift(
      { role: 'reload', label: m.reload },
      { role: 'forceReload', label: m.forceReload },
      { role: 'toggleDevTools', label: m.devTools },
      { type: 'separator' },
    );
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about', label: m.about(app.name) },
              { type: 'separator' },
              { role: 'hide', label: m.hide(app.name) },
              { role: 'hideOthers', label: m.hideOthers },
              { role: 'unhide', label: m.showAll },
              { type: 'separator' },
              { role: 'quit', label: m.quit(app.name) },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: m.file,
      submenu: [isMac ? { role: 'close', label: m.close } : { role: 'quit', label: m.exit }],
    },
    {
      label: m.edit,
      submenu: [
        { role: 'undo', label: m.undo },
        { role: 'redo', label: m.redo },
        { type: 'separator' },
        { role: 'cut', label: m.cut },
        { role: 'copy', label: m.copy },
        { role: 'paste', label: m.paste },
        { role: 'selectAll', label: m.selectAll },
      ],
    },
    { label: m.view, submenu: viewItems },
    {
      label: m.window,
      submenu: [
        { role: 'minimize', label: m.minimize },
        { role: 'zoom', label: m.zoom },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
