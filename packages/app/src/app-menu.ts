import type { MenuItemConstructorOptions } from 'electron';

export interface AppMenuOptions {
  isMac: boolean;
  onUpdateInvokerCli: () => void;
}

/**
 * Pure template builder (no Electron runtime imports) so it can be unit
 * tested under plain Node. main.ts passes the result to
 * `Menu.buildFromTemplate` / `Menu.setApplicationMenu`.
 */
export function buildAppMenuTemplate(options: AppMenuOptions): MenuItemConstructorOptions[] {
  return [
    ...(options.isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: 'Tools',
      submenu: [
        {
          label: 'Update invoker-cli',
          click: () => options.onUpdateInvokerCli(),
        },
      ],
    },
  ];
}
