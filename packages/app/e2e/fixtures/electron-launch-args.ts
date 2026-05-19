export function electronE2ELaunchArgs(mainPath: string): string[] {
  if (process.platform !== 'linux') {
    return [mainPath];
  }

  return [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--disable-gpu-sandbox',
    '--disable-software-rasterizer',
    mainPath,
  ];
}
