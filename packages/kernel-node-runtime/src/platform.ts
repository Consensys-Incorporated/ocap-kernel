/**
 * Throw if the kernel cannot run on the given platform.
 *
 * @param platform - The platform to check.
 */
export function assertSupportedPlatform(
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') {
    throw new Error('The ocap kernel does not support Windows.');
  }
}
