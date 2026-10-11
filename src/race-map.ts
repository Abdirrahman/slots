import { sampleTrackPose, type TrackPose } from "./presentation";
import type { CarState, Track } from "./race";

/** Cache the circuit silhouette; only the racer markers change each frame. */
export function createRaceMap(canvas: HTMLCanvasElement, track: Track) {
  const context = canvas.getContext("2d")!;
  const width = canvas.width, height = canvas.height;
  const poses = Array.from({ length: 180 }, (_, i) => sampleTrackPose(track, i / 180 * track.length, 1.5));
  const minX = Math.min(...poses.map(p => p.x)), maxX = Math.max(...poses.map(p => p.x));
  const minZ = Math.min(...poses.map(p => p.z)), maxZ = Math.max(...poses.map(p => p.z));
  const scale = Math.min((width - 36) / (maxX - minX), (height - 34) / (maxZ - minZ));
  const project = (pose: Pick<TrackPose, "x" | "z">) => [
    width / 2 + (pose.x - (minX + maxX) / 2) * scale,
    height / 2 + (pose.z - (minZ + maxZ) / 2) * scale,
  ] as const;
  const background = document.createElement("canvas");
  background.width = width; background.height = height;
  const base = background.getContext("2d")!;
  base.beginPath();
  for (const [i, pose] of poses.entries()) {
    const [x, y] = project(pose);
    if (i === 0) base.moveTo(x, y); else base.lineTo(x, y);
  }
  base.closePath();
  base.lineJoin = "round";
  base.strokeStyle = "#12283a"; base.lineWidth = 10; base.stroke();
  base.strokeStyle = "#769aa5"; base.lineWidth = 2.5; base.stroke();
  const [startX, startY] = project(poses[0]!);
  base.fillStyle = "#fff5d9"; base.fillRect(startX - 2, startY - 5, 4, 10);
  const palette = ["#ff6f55", "#ffc060", "#69e7ff", "#d8a0ff"];
  return (cars: readonly CarState[], localId: string | null, presented: ReadonlyMap<string, TrackPose>) => {
    context.clearRect(0, 0, width, height);
    context.drawImage(background, 0, 0);
    for (const [i, car] of cars.entries()) {
      const [x, y] = project(presented.get(car.id) ?? sampleTrackPose(track, car.progress, car.lane));
      const local = car.id === localId;
      context.beginPath(); context.arc(x, y, local ? 5.5 : 3.5, 0, Math.PI * 2);
      context.fillStyle = local ? "#fff4d9" : palette[i % palette.length]!;
      context.shadowColor = context.fillStyle; context.shadowBlur = local ? 10 : 0;
      context.fill(); context.shadowBlur = 0;
      if (local) { context.strokeStyle = "#f6ae47"; context.lineWidth = 2; context.stroke(); }
    }
  };
}
