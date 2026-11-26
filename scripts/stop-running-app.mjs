// `tauri build` fails with "Access is denied" when a Luma Palette instance
// launched from this repo's target/ folder is still running: the process holds
// its own exe open. Stop only those instances; an installed copy elsewhere on
// the machine is left alone.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

if (process.platform === "win32") {
  const targetDir = path
    .resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "target")
    .toLowerCase();

  const list = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-Process luma-palette-csp -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.Id)|$($_.Path)\" }",
    ],
    { encoding: "utf8" },
  );

  const victims = (list.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, ...rest] = line.split("|");
      return { id: Number(id), exe: rest.join("|").toLowerCase() };
    })
    .filter((p) => p.exe.startsWith(targetDir));

  for (const p of victims) {
    spawnSync("taskkill", ["/F", "/PID", String(p.id)], { stdio: "ignore" });
    console.log(`[pretauri] stopped running build (pid ${p.id}) so the exe can be replaced`);
  }

  if (victims.length) {
    // Give Windows a beat to release the file handle before cargo tries to delete it.
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
