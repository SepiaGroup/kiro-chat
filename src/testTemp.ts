// Test helper: delete a temp folder. On Windows a folder stays busy for a moment
// after the program that ran in it has exited, so it is retried. Cleaning up is
// not what a test checks, so a folder that still can't be deleted is left to the
// system's temp cleanup.

import { rmSync } from "fs";

export async function removeTempDir(dir: string, tries = 30): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}
