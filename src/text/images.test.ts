import { describe, expect, it } from "vitest";
import { droppedImageName, extForMime, imageMarkup, imageRefs, isImageFile, networkShare, pastedImageName, resolveImage } from "./images";

describe("image references in notes", () => {
  it("finds the images written on a line", () => {
    expect(imageRefs("plain text")).toEqual([]);
    expect(imageRefs("![image](images/a.png)")).toEqual(["images/a.png"]);
    expect(imageRefs('see ![one](a.png "title") and ![](<my shots/b c.jpg>)')).toEqual(["a.png", "my shots/b c.jpg"]);
    expect(imageRefs("[a link](a.png) and ![broken](no closing")).toEqual([]);
  });

  it("names pasted images after the note and the time, safely", () => {
    const at = new Date(2026, 10, 9, 8, 5, 3);
    expect(pastedImageName("work", at, "png")).toBe("work-2026-11-09-080503.png");
    expect(pastedImageName("Réunion (lundi)", at, "jpg", 2)).toBe("Réunion-lundi-2026-11-09-080503-2.jpg");
    expect(pastedImageName("../..", at, "png")).toBe("image-2026-11-09-080503.png");
  });

  it("names dropped images after their own name, safely", () => {
    expect(droppedImageName("diagram.PNG")).toBe("diagram.png");
    expect(droppedImageName("My shot (1).jpg", 2)).toBe("My-shot-1-2.jpg");
    expect(droppedImageName("../../x.gif")).toBe("x.gif");
    expect(isImageFile("C:\\a\\b.WebP")).toBe(true);
    expect(isImageFile("/a/run.exe")).toBe(false);
  });

  it("writes a reference that reads back to the same file", () => {
    expect(imageMarkup("images", "a.png")).toBe("![image](images/a.png)");
    expect(imageMarkup("my shots\\2026", "a b.png")).toBe("![image](<my shots/2026/a b.png>)");
    expect(imageRefs(imageMarkup("my shots", "a b.png"))).toEqual(["my shots/a b.png"]);
  });

  it("resolves a reference next to the note, or an absolute path; never a web image", () => {
    expect(resolveImage("images/a.png", "/notes")).toBe("/notes/images/a.png");
    expect(resolveImage("./images/a%20b.png", "/notes")).toBe("/notes/images/a b.png");
    expect(resolveImage("images/a.png", "C:\\Notes")).toBe("C:\\Notes\\images\\a.png");
    expect(resolveImage("C:/Shots/a.PNG", "/notes")).toBe("C:/Shots/a.PNG");
    expect(resolveImage("images/a.png", null)).toBeNull();
    for (const ref of ["https://example.com/a.png", "http://x/a.png", "data:image/png;base64,AAAA", "file:///c/a.png", "javascript:alert(1).png", "notes.txt", "run.exe"]) {
      expect(resolveImage(ref, "/notes"), ref).toBeNull();
    }
  });

  it("knows which pasted types a note can hold", () => {
    expect(extForMime("image/png")).toBe("png");
    expect(extForMime("image/jpeg")).toBe("jpg");
    expect(extForMime("image/tiff")).toBeNull();
    expect(extForMime("text/html")).toBeNull();
  });
});

describe("images on other computers", () => {
  it("are never read from a note: no connection to another computer", () => {
    for (const ref of ["\\\\attacker\\share\\a.png", "//attacker/share/a.png", "\\\\attacker@SSL\\a.png", "%5C%5Cattacker%5Cshare%5Ca.png", "/\\attacker\\share\\a.png"]) {
      expect(resolveImage(ref, "C:\\Notes")).toBeNull();
      expect(resolveImage(ref, null)).toBeNull();
    }
    // Device paths, never.
    expect(resolveImage("\\\\?\\C:\\x.png", "C:\\Notes")).toBeNull();
    expect(resolveImage("\\\\.\\pipe\\x.png", "C:\\Notes")).toBeNull();
  });

  it("are read from the share the note itself comes from", () => {
    const dir = "\\\\Files\\Team\\notes";
    expect(resolveImage("images/a.png", dir)).toBe("\\\\Files\\Team\\notes\\images\\a.png");
    expect(resolveImage("\\\\files\\team\\shots\\b.png", dir)).toBe("\\\\files\\team\\shots\\b.png");
    expect(resolveImage("\\\\files\\other\\b.png", dir)).toBeNull();
    expect(networkShare("//Files/Team/x")).toBe("files\\team");
    expect(networkShare("C:\\Notes")).toBeNull();
  });
});
