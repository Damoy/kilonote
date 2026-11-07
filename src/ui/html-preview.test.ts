// @vitest-environment happy-dom
// @vitest-environment-options {"settings": {"handleDisabledFileLoadingAsSuccess": true}}
import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "./html-preview";

describe("HTML preview", () => {
  it("removes everything that could run code or load something", () => {
    const doc = sanitizeHtml(`<!doctype html><html><head>
      <base href="https://example.com/"><link rel="stylesheet" href="style.css">
      <link rel="dns-prefetch" href="//tracker.example"><meta http-equiv="refresh" content="0;url=https://example.com">
      <script>alert(1)</script><style>h1 { color: red }</style></head>
      <body onload="alert(1)"><h1 onclick="alert(1)">Title</h1>
      <a href="javascript:alert(1)">bad</a><a href="https://example.com/ok">ok</a>
      <iframe srcdoc="<b>x</b>"></iframe><object data="x.swf"></object><embed src="x">
      <form action="https://example.com/post"><input name="q"></form>
      <svg><script>alert(1)</script><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>
      <img src="data:text/html,<script>alert(1)</script>"><noscript><img src=x></noscript></body></html>`);
    const html = doc.documentElement.outerHTML;
    for (const bad of ["<script", "<base", "<link", "http-equiv", "onload", "onclick", "javascript:", "<iframe", "<object", "<embed", "<noscript", "data:text/html", 'action="'])
      expect(html, bad).not.toContain(bad);
    expect(doc.querySelector("style")?.textContent).toContain("color: red");
    expect(doc.querySelector('a[href="https://example.com/ok"]')).not.toBeNull();
    expect(doc.querySelector("h1")?.textContent).toBe("Title");
    expect(doc.querySelectorAll("img[src]").length).toBe(0); // remote and data:text/html images
  });

  it("sees through obfuscated URLs and keeps the keyboard in the editor", () => {
    const doc = sanitizeHtml('<a id="a" href="java\nscript:alert(1)">x</a><a id="b" href=" &#14;javascript:alert(1)">y</a><input id="c" autofocus><video id="d" autoplay></video><svg><image id="e" href="https://example.com/x.png"/><use id="f" xlink:href="//example.com/s.svg#i"/></svg>');
    for (const id of ["a", "b"]) expect(doc.getElementById(id)?.hasAttribute("href"), id).toBe(false);
    expect(doc.getElementById("c")?.hasAttribute("autofocus")).toBe(false);
    expect(doc.getElementById("d")?.hasAttribute("autoplay")).toBe(false);
    expect(doc.getElementById("e")?.hasAttribute("href")).toBe(false);
    expect(doc.getElementById("f")?.getAttributeNames().some((n) => n.includes("href"))).toBe(false);
  });

  it("keeps embedded images and drops remote ones", () => {
    const doc = sanitizeHtml('<img id="a" src="data:image/png;base64,AAAA"><img id="b" src="https://example.com/x.png"><img id="c" src="//cdn.example/x.png"><video id="d" poster="http://x/p.png"></video>');
    expect(doc.getElementById("a")?.getAttribute("src")).toContain("data:image/png");
    expect(doc.getElementById("b")?.hasAttribute("src")).toBe(false);
    expect(doc.getElementById("c")?.hasAttribute("src")).toBe(false);
    expect(doc.getElementById("d")?.hasAttribute("poster")).toBe(false);
  });
});
