import { describe, expect, it, vi } from 'vitest';

import { buildAppMenuTemplate } from '../app-menu.js';

function findUpdateItem(template: ReturnType<typeof buildAppMenuTemplate>) {
  const tools = template.find((item) => item.label === 'Tools');
  const submenu = tools?.submenu;
  if (!Array.isArray(submenu)) return undefined;
  return submenu.find((item) => item.label === 'Update invoker-cli');
}

describe('buildAppMenuTemplate', () => {
  it('includes a Tools → Update invoker-cli item that fires the callback', () => {
    const onUpdateInvokerCli = vi.fn();
    const template = buildAppMenuTemplate({ isMac: true, onUpdateInvokerCli });

    const item = findUpdateItem(template);
    expect(item).toBeDefined();
    (item?.click as () => void)();
    expect(onUpdateInvokerCli).toHaveBeenCalledTimes(1);
  });

  it('includes the appMenu role only on macOS', () => {
    const mac = buildAppMenuTemplate({ isMac: true, onUpdateInvokerCli: () => {} });
    const linux = buildAppMenuTemplate({ isMac: false, onUpdateInvokerCli: () => {} });

    expect(mac[0]?.role).toBe('appMenu');
    expect(linux.some((item) => item.role === 'appMenu')).toBe(false);
    expect(findUpdateItem(linux)).toBeDefined();
  });
});
