import { MAX_IMAGE_BYTES, readPastedImage, withPastedImages } from "./pastedImages";
import { classifyReferencePath, extractMessageSegments } from "./messageImages";

it("reads a clipboard raster and preserves it as a renderable image message", async () => {
  const url = await readPastedImage(new File(["hello"], "image.png", { type: "image/png" }));
  expect(url).toBe("data:image/png;base64,aGVsbG8=");
  const message = withPastedImages("", [url]);
  expect(extractMessageSegments(message)).toEqual([{ type: "image", path: url }]);
  expect(classifyReferencePath(url)).toEqual({ type: "image", path: url });
  expect(withPastedImages(" hello ", [url])).toBe(`hello\n\n${message}`);
});

it("rejects unsupported types and oversized images", async () => {
  await expect(readPastedImage(new File(["<svg/>"], "a.svg", { type: "image/svg+xml" }))).rejects.toThrow("PNG");
  await expect(readPastedImage(new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "a.png", { type: "image/png" }))).rejects.toThrow("5MB");
});
