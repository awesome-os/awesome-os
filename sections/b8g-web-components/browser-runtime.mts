/**
 * @file sections/b8g-web-components/browser-runtime.mts
 * @description Self-contained browser runtime generator for the canonical 6-tag
 * `<b8g-*>` Streaming Web Components standard using HTML5 `data-*` attributes (`el.dataset.*`).
 *
 * Strictly portable: zero external dependencies, zero `node:*` imports,
 * `erasableSyntaxOnly: true`.
 */

/**
 * Returns a clean, self-contained browser JavaScript IIFE that registers all
 * 6 canonical `<b8g-*>` custom elements via `customElements.define(...)`:
 *   - `b8g-section` (`id`, `data-kind`, `data-surface`, `data-liveness`)
 *   - `b8g-intersection` (`data-op`, `data-with`)
 *   - `b8g-stream` (`data-src`, `data-liveness`; fetches/streams via `AbortController`, auto-cancels in `disconnectedCallback`)
 *   - `b8g-surface` (`data-backend`, `width`, `height`; auto-mounts `<canvas>` when `data-backend="canvas-2d"|"canvas-3d"`)
 *   - `b8g-dropzone` (`data-accept`, `data-onmount`; handles `dragover`/`drop` and dispatches `b8g-drop` CustomEvent)
 *   - `b8g-gate` (`data-persona`, `data-locality`; hides/removes children when persona doesn't match `document.documentElement.dataset.b8gPersona || 'consumer'`)
 */
export function renderB8gWebComponentsRuntimeScript(): string {
  return `(function () {
  'use strict';
  if (typeof globalThis === 'undefined' || typeof globalThis.customElements === 'undefined' || typeof globalThis.HTMLElement === 'undefined') {
    return;
  }

  var PERSONA_RANK = {
    'consumer': 0,
    'creator': 1,
    'devops': 2,
    'kernel-audit': 3
  };

  function getPersonaRank(persona) {
    var key = typeof persona === 'string' && persona.length > 0 ? persona : 'consumer';
    return Object.prototype.hasOwnProperty.call(PERSONA_RANK, key) ? PERSONA_RANK[key] : 0;
  }

  function readProp(el, dataKey, fallbackAttr) {
    if (el.dataset && typeof el.dataset[dataKey] === 'string' && el.dataset[dataKey].length > 0) {
      return el.dataset[dataKey];
    }
    return el.getAttribute('data-' + fallbackAttr) || el.getAttribute(fallbackAttr) || '';
  }

  function defineOnce(tagName, ctor) {
    if (!customElements.get(tagName)) {
      customElements.define(tagName, ctor);
    }
  }

  class B8gSectionElement extends HTMLElement {
    static get observedAttributes() {
      return ['id', 'data-kind', 'data-surface', 'data-liveness'];
    }
    connectedCallback() {
      this._syncAttributes();
    }
    attributeChangedCallback() {
      this._syncAttributes();
    }
    _syncAttributes() {
      var kind = readProp(this, 'kind', 'kind');
      var surface = readProp(this, 'surface', 'surface');
      var liveness = readProp(this, 'liveness', 'liveness');
      if (kind) this.dataset.kind = kind;
      if (surface) this.dataset.surface = surface;
      if (liveness) this.dataset.liveness = liveness;
    }
  }

  class B8gIntersectionElement extends HTMLElement {
    static get observedAttributes() {
      return ['data-op', 'data-with'];
    }
    connectedCallback() {
      this._syncAttributes();
    }
    attributeChangedCallback() {
      this._syncAttributes();
    }
    _syncAttributes() {
      var op = readProp(this, 'op', 'op') || 'wedge';
      var withAttr = readProp(this, 'with', 'with');
      this.dataset.op = op;
      if (withAttr) this.dataset.with = withAttr;
    }
  }

  class B8gSurfaceElement extends HTMLElement {
    static get observedAttributes() {
      return ['data-backend', 'width', 'height'];
    }
    connectedCallback() {
      this._mountSurface();
    }
    attributeChangedCallback() {
      this._mountSurface();
    }
    getCanvas() {
      return this.querySelector('canvas[data-b8g-surface-canvas="true"]');
    }
    _mountSurface() {
      var backend = readProp(this, 'backend', 'backend') || 'html-dom';
      this.dataset.backend = backend;
      if (backend === 'canvas-2d' || backend === 'canvas-3d') {
        var canvas = this.getCanvas();
        if (!canvas) {
          canvas = document.createElement('canvas');
          canvas.setAttribute('data-b8g-surface-canvas', 'true');
          this.appendChild(canvas);
        }
        var width = this.getAttribute('width');
        var height = this.getAttribute('height');
        if (width) canvas.width = Number(width) || 300;
        if (height) canvas.height = Number(height) || 150;
      }
    }
  }

  class B8gDropzoneElement extends HTMLElement {
    static get observedAttributes() {
      return ['data-accept', 'data-onmount'];
    }
    constructor() {
      super();
      this._onDragOver = this._handleDragOver.bind(this);
      this._onDragLeave = this._handleDragLeave.bind(this);
      this._onDrop = this._handleDrop.bind(this);
    }
    connectedCallback() {
      this.addEventListener('dragover', this._onDragOver);
      this.addEventListener('dragleave', this._onDragLeave);
      this.addEventListener('drop', this._onDrop);
    }
    disconnectedCallback() {
      this.removeEventListener('dragover', this._onDragOver);
      this.removeEventListener('dragleave', this._onDragLeave);
      this.removeEventListener('drop', this._onDrop);
    }
    _handleDragOver(event) {
      event.preventDefault();
      this.dataset.b8gDragover = 'true';
    }
    _handleDragLeave() {
      delete this.dataset.b8gDragover;
    }
    _handleDrop(event) {
      event.preventDefault();
      delete this.dataset.b8gDragover;
      var files = event.dataTransfer && event.dataTransfer.files ? Array.from(event.dataTransfer.files) : [];
      var accept = readProp(this, 'accept', 'accept');
      var onmount = readProp(this, 'onmount', 'onmount');
      this.dispatchEvent(new CustomEvent('b8g-drop', {
        bubbles: true,
        composed: true,
        detail: {
          files: files,
          accept: accept,
          onmount: onmount
        }
      }));
    }
  }

  class B8gGateElement extends HTMLElement {
    static get observedAttributes() {
      return ['data-persona', 'data-locality'];
    }
    connectedCallback() {
      this._evaluateGate();
    }
    attributeChangedCallback() {
      this._evaluateGate();
    }
    _evaluateGate() {
      var requiredPersona = readProp(this, 'persona', 'persona') || 'consumer';
      var activePersona = (document.documentElement && document.documentElement.dataset && document.documentElement.dataset.b8gPersona) || 'consumer';
      if (getPersonaRank(activePersona) < getPersonaRank(requiredPersona)) {
        this.hidden = true;
        this.style.display = 'none';
        while (this.firstChild) {
          this.removeChild(this.firstChild);
        }
        this.dataset.b8gCollapsed = 'true';
      } else {
        this.hidden = false;
        this.dataset.b8gCollapsed = 'false';
      }
    }
  }

  class B8gStreamElement extends HTMLElement {
    static get observedAttributes() {
      return ['data-src', 'data-liveness'];
    }
    constructor() {
      super();
      this._abortController = null;
    }
    connectedCallback() {
      this._startStream();
    }
    attributeChangedCallback(name, oldVal, newVal) {
      if (name === 'data-src' && oldVal !== newVal && this.isConnected) {
        this._startStream();
      }
    }
    disconnectedCallback() {
      this._stopStream();
    }
    _stopStream() {
      if (this._abortController) {
        this._abortController.abort();
        this._abortController = null;
      }
      this.dataset.b8gStreamState = 'aborted';
    }
    _startStream() {
      this._stopStream();
      var src = readProp(this, 'src', 'src');
      if (!src || typeof fetch !== 'function') {
        this.dataset.b8gStreamState = 'idle';
        return;
      }
      var controller = new AbortController();
      this._abortController = controller;
      this.dataset.b8gStreamState = 'connecting';
      var self = this;
      fetch(src, { signal: controller.signal })
        .then(function (response) {
          if (!response.ok) {
            throw new Error('b8g-stream HTTP ' + response.status);
          }
          self.dataset.b8gStreamState = 'streaming';
          if (response.body && typeof response.body.getReader === 'function') {
            var reader = response.body.getReader();
            var decoder = typeof TextDecoder === 'function' ? new TextDecoder() : null;
            function pump() {
              return reader.read().then(function (result) {
                if (result.done) {
                  self.dataset.b8gStreamState = 'closed';
                  self.dispatchEvent(new CustomEvent('b8g-stream-end', { bubbles: true, composed: true }));
                  return;
                }
                var text = decoder ? decoder.decode(result.value, { stream: true }) : String(result.value);
                self.dispatchEvent(new CustomEvent('b8g-stream-chunk', {
                  bubbles: true,
                  composed: true,
                  detail: { chunk: text, bytes: result.value }
                }));
                return pump();
              });
            }
            return pump();
          }
          return response.text().then(function (text) {
            self.dispatchEvent(new CustomEvent('b8g-stream-chunk', {
              bubbles: true,
              composed: true,
              detail: { chunk: text }
            }));
            self.dataset.b8gStreamState = 'closed';
            self.dispatchEvent(new CustomEvent('b8g-stream-end', { bubbles: true, composed: true }));
          });
        })
        .catch(function (err) {
          if (err && err.name === 'AbortError') {
            self.dataset.b8gStreamState = 'aborted';
            return;
          }
          self.dataset.b8gStreamState = 'error';
          self.dispatchEvent(new CustomEvent('b8g-stream-error', {
            bubbles: true,
            composed: true,
            detail: { error: err ? String(err.message || err) : 'unknown' }
          }));
        });
    }
  }

  defineOnce('b8g-section', B8gSectionElement);
  defineOnce('b8g-intersection', B8gIntersectionElement);
  defineOnce('b8g-stream', B8gStreamElement);
  defineOnce('b8g-surface', B8gSurfaceElement);
  defineOnce('b8g-dropzone', B8gDropzoneElement);
  defineOnce('b8g-gate', B8gGateElement);
})();
`
}
