import { describe, expect, it } from "vitest";
import { RasterizeError, rasterizeSvg } from "./index.js";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("rasterizeSvg", () => {
  it("renders a non-blank PNG of the expected size", () => {
    const png = rasterizeSvg('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#d93025"/><text x="2" y="14">ab</text></svg>', { scale: 2 });
    expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    const view = new DataView(png.buffer, png.byteOffset);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([80, 40]);
  });

  it("refuses oversized diagrams", () => {
    expect(() => rasterizeSvg('<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="10"></svg>')).toThrow(RasterizeError);
  });
});
