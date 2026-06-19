const canvasMockCtx = new Proxy({}, {
  get: (target, prop) => {
    if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
      return () => ({ addColorStop: () => {} });
    }
    return () => {};
  }
});

class MockElement {
  constructor(id) {
    this.id = id;
    this.clientWidth = 200;
    this.clientHeight = 100;
    this.style = {};
    this.classList = { toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false };
    this.parentElement = { getBoundingClientRect: () => ({ width: 800, height: 600 }) };
    this.dataset = {};
  }
  getContext() { return canvasMockCtx; }
  querySelector() { return new MockElement(); }
  querySelectorAll() { return [new MockElement()]; }
  addEventListener() {}
  setAttribute() {}
  getAttribute() {}
  append() {}
  appendChild() {}
}

global.window = {
  devicePixelRatio: 1,
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  addEventListener: () => {},
  removeEventListener: () => {},
  navigator: { userAgent: '' }
};

global.document = {
  getElementById: (id) => new MockElement(id),
  createElement: () => new MockElement(),
  querySelector: () => new MockElement(),
  querySelectorAll: () => [new MockElement()],
  body: new MockElement('body'),
  documentElement: new MockElement('html'),
  addEventListener: () => {},
  createDocumentFragment: () => new MockElement()
};

global.HTMLElement = class HTMLElement {};
global.Image = class Image { constructor() { this.src = ''; } };
global.Audio = class Audio { constructor() { this.src = ''; } };
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
global.localStorage = { getItem: () => null, setItem: () => {} };

global.performance = { now: () => Date.now() };

global.requestAnimationFrame = (cb) => setTimeout(cb, 16);
global.cancelAnimationFrame = () => {};

global.AudioContext = class {
  constructor() { this.state = 'running'; }
  createAnalyser() { return { fftSize: 2048, frequencyBinCount: 1024, getFloatTimeDomainData: () => {} }; }
};

const { game } = await import('./app.js');

game.prismReader = {
  syllables: [
    { state: 'crystallized', avgF0: 100, hue: 0 },
    { state: 'crystallized', avgF0: 150, hue: 60 },
    { state: 'crystallized', avgF0: 200, hue: 120 },
    { state: 'pending', avgF0: 0, hue: 0 }
  ]
};

const canvasEl = new MockElement('prismSparkline');
game._drawPrismPitchSparkline(canvasEl);
console.log('Test successful: function ran without error on mocked syllables.');
process.exit(0);
