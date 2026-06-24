// Render Mermaid diagrams from a locally-vendored copy of mermaid (see
// docs/javascripts/mermaid.min.js) so diagrams work on an offline / self-hosted
// Talos. Material's built-in integration pulls mermaid from a CDN at runtime,
// which fails without internet access — so we drive it ourselves instead.
(function () {
  function render() {
    if (typeof mermaid === "undefined") return;
    // pymdownx emits each diagram as `<pre class="mermaid"><code>…</code></pre>`.
    // mermaid.run reads the element's markup, and the inner <code> tag breaks its
    // diagram-type detection ("No diagram type detected …"). Collapsing to the
    // decoded textContent leaves the bare diagram source it expects.
    document.querySelectorAll(".mermaid:not([data-processed])").forEach(function (el) {
      el.textContent = el.textContent;
    });
    var dark = document.body.getAttribute("data-md-color-scheme") === "slate";
    mermaid.initialize({
      startOnLoad: false,
      theme: dark ? "dark" : "default",
      securityLevel: "strict",
    });
    mermaid.run({ querySelector: ".mermaid:not([data-processed])" });
  }

  // Render the page we loaded on. `document$` (Material's RxJS Subject) only
  // emits on *future* instant-navigation swaps and may have already fired for
  // the initial page before this late-loaded script subscribed — so render now
  // and also re-render after each navigation.
  render();
  if (typeof document$ !== "undefined") {
    document$.subscribe(render);
  }
})();
