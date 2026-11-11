// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { unusedImages } from "./images";

describe("unused images, with Windows paths", () => {
  it("are found whatever the case and the slashes of the references", () => {
    const files = ["C:\\Notes\\images\\Used.PNG", "C:\\Notes\\images\\old.png", "C:\\Notes\\sub\\images\\up.png", "C:\\Notes\\photos\\trip.png"];
    const notes = [
      { path: "C:\\Notes\\a.txt", text: "![image](images/used.png)\r\nend" },
      { path: "C:\\Notes\\sub\\b.md", text: "![x](images\\up.png)" },
    ];
    expect(unusedImages(files, notes, "images")).toEqual(["C:\\Notes\\images\\old.png"]);
    // A note that could not be read keeps the images next to it.
    expect(unusedImages(files, [...notes, { path: "C:\\Notes\\big.txt", text: null }], "images")).toEqual([]);
  });
});
