// Stands in for the ELK layout engine of Mermaid (elkjs, 1.5 MB, licensed EPL-2.0
// or GPL-3.0). KiloNote draws with Mermaid's dagre layout (MIT) instead: the
// diagrams look the classic Mermaid way, and only a diagram that explicitly
// asks for "layout: elk" gets a message.
const message = 'The "elk" layout is not included in KiloNote: remove "layout: elk" to draw this diagram with the default layout.';

export default class ELK {
  layout(): Promise<never> {
    return Promise.reject(new Error(message));
  }
  knownLayoutAlgorithms(): Promise<never[]> {
    return Promise.resolve([]);
  }
  knownLayoutOptions(): Promise<never[]> {
    return Promise.resolve([]);
  }
  knownLayoutCategories(): Promise<never[]> {
    return Promise.resolve([]);
  }
  terminateWorker() {}
}
