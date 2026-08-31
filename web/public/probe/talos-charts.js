var TalosCharts = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // entry.mjs
  var entry_exports = {};
  __export(entry_exports, {
    mount: () => mount,
    mountAll: () => mountAll,
    types: () => types
  });

  // node_modules/@tanstack/charts/dist/scale-input.js
  function resolveScaleInput(source, options) {
    const infer = isScaleFactory(source);
    const created = infer ? source() : source;
    if (typeof created !== "function" || typeof created.copy !== "function" || typeof created.domain !== "function" || typeof created.range !== "function") {
      throw new TypeError(
        "A scale factory must return a copyable scale with domain and range methods"
      );
    }
    const scale = created.copy();
    if (infer) {
      const domain = inferScaleDomain(scale, options.values, options.includeZero);
      if (domain) {
        const inferable = scale;
        inferable.domain(domain);
      }
    }
    applyScaleNice(scale, options.nice, options.niceCount);
    return scale;
  }
  function isScaleFactory(source) {
    return typeof source === "function" && !("copy" in source);
  }
  function resolveNumericScale(source, values) {
    if (!source) return void 0;
    if (typeof source === "function") return source;
    const scale = resolveScaleInput(source.scale, {
      values,
      includeZero: true,
      nice: source.nice,
      niceCount: 5
    });
    return (value2) => scale(value2) ?? Number.NaN;
  }
  function inferScaleDomain(scale, values, includeZero = false) {
    const observed = values.filter(isChartValue);
    if (!observed.length) return void 0;
    if (typeof scale.bandwidth === "function" || typeof scale.ticks !== "function") {
      const domain = [];
      const seen = /* @__PURE__ */ new Set();
      for (const value2 of observed) {
        const key = value2 instanceof Date ? `date:${value2.getTime()}` : `${typeof value2}:${String(value2)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        domain.push(value2);
      }
      return domain;
    }
    const temporal = scale.domain().some((value2) => value2 instanceof Date);
    if (temporal) {
      const dates = observed.filter(
        (value2) => value2 instanceof Date
      );
      if (dates.length !== observed.length) {
        throw new TypeError(
          "A temporal scale factory requires Date channel values"
        );
      }
      let minimum2 = Infinity;
      let maximum2 = -Infinity;
      for (const value2 of dates) {
        const number5 = value2.getTime();
        minimum2 = Math.min(minimum2, number5);
        maximum2 = Math.max(maximum2, number5);
      }
      if (!Number.isFinite(minimum2) || !Number.isFinite(maximum2)) {
        throw new TypeError(
          "A temporal scale factory requires Date channel values"
        );
      }
      if (minimum2 === maximum2) {
        const halfDay = 432e5;
        minimum2 -= halfDay;
        maximum2 += halfDay;
      }
      return [new Date(minimum2), new Date(maximum2)];
    }
    let minimum = Infinity;
    let maximum = -Infinity;
    for (const value2 of observed) {
      if (!isFiniteNumber(value2)) {
        throw new TypeError(
          "A quantitative scale factory requires numeric values"
        );
      }
      minimum = Math.min(minimum, value2);
      maximum = Math.max(maximum, value2);
    }
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
      throw new TypeError("A quantitative scale factory requires numeric values");
    }
    const logarithmic = isLogarithmicScale(scale);
    if (includeZero) {
      if (logarithmic) {
        throw new TypeError(
          "An inferred log scale cannot include an implicit zero baseline"
        );
      }
      minimum = Math.min(0, minimum);
      maximum = Math.max(0, maximum);
    }
    validateInferredLogDomain(scale, minimum, maximum);
    if (minimum === maximum) {
      if (minimum === 0) return [0, 1];
      const offset = Math.abs(minimum) * 0.05 || 1;
      minimum -= offset;
      maximum += offset;
    }
    return [minimum, maximum];
  }
  function isLogarithmicScale(scale) {
    return "base" in scale && typeof scale.base === "function";
  }
  function validateInferredLogDomain(scale, minimum, maximum) {
    if (isLogarithmicScale(scale) && (minimum === 0 || maximum === 0 || minimum < 0 && maximum > 0)) {
      throw new TypeError("An inferred log domain cannot include or cross zero");
    }
  }
  function applyScaleNice(scale, nice, defaultCount = 5) {
    if (!nice) return;
    const candidate = scale;
    if (typeof candidate.nice !== "function") {
      throw new TypeError("This scale does not support nicening");
    }
    candidate.nice(typeof nice === "number" ? nice : defaultCount);
  }

  // node_modules/@tanstack/charts/dist/scales.js
  function createColorScale(values, options, theme) {
    if (options?.scale) {
      const infer = isColorScaleFactory(options.scale);
      const source = infer ? options.scale() : options.scale;
      if (typeof source !== "function" || typeof source.copy !== "function") {
        throw new TypeError("A color scale must be callable and copyable");
      }
      if (infer && (typeof source.domain !== "function" || typeof source.range !== "function")) {
        throw new TypeError(
          "A color scale factory must return a scale with domain and range methods"
        );
      }
      const scale = source.copy();
      const kind = colorScaleKind(scale);
      if (infer) {
        const inferable = scale;
        if (options.range?.length) {
          inferable.range(options.range);
        }
        const domain3 = options.domain ?? inferColorDomain(inferable, values);
        if (options.domain !== void 0 || domain3.length) {
          inferable.domain(domain3);
        }
        const range3 = inferable.range();
        if (!range3.length || range3.some((value2) => typeof value2 !== "string")) {
          throw new TypeError("A color-scale factory requires a string range");
        }
      }
      if (options.nice) {
        const nice = scale.nice;
        if (typeof nice !== "function") {
          throw new TypeError("This color scale does not support nicening");
        }
        nice.call(scale, typeof options.nice === "number" ? options.nice : 5);
      }
      const domain2 = scale.domain?.() ?? options.domain ?? [];
      const range22 = (scale.range?.() ?? options.range ?? theme.palette).map(
        String
      );
      return {
        type: "configured",
        kind,
        domain: domain2,
        range: range22,
        map: (value2) => {
          if (value2 == null) return range22[0] ?? "currentColor";
          const output = scale(value2);
          return output == null ? "currentColor" : String(output);
        }
      };
    }
    if (options?.resolver) {
      return options.resolver.resolve({
        values,
        domain: options.domain,
        range: options.range,
        theme
      });
    }
    const range2 = options?.range?.length ? options.range : theme.palette;
    const domain = uniqueChartKeys(options?.domain ?? values);
    const mappedKeys = domain.map(valueKey);
    const map2 = (value2) => {
      if (value2 == null) return range2[0] ?? "currentColor";
      let index = mappedKeys.indexOf(valueKey(value2));
      if (index < 0) index = mappedKeys.push(valueKey(value2)) - 1;
      return range2[index % range2.length] ?? "currentColor";
    };
    return { type: "ordinal", kind: "categorical", domain, range: range2, map: map2 };
  }
  function uniqueChartKeys(values) {
    return [...new Set(values.filter(isChartKey))];
  }
  function isChartKey(value2) {
    return typeof value2 === "string" || typeof value2 === "number";
  }
  function isColorScaleFactory(source) {
    return typeof source === "function" && !("copy" in source);
  }
  function inferColorDomain(scale, values) {
    const observed = values.filter(isChartKey);
    const quantiles = scale.quantiles;
    const thresholds = scale.thresholds;
    if (quantiles) {
      return quantitativeColorValues(observed);
    }
    if (scale.invertExtent && !thresholds) {
      throw new TypeError(
        "Threshold color-scale factory requires an explicit domain"
      );
    }
    if (scale.ticks || thresholds) {
      const numeric = quantitativeColorValues(observed);
      let minimum = Infinity;
      let maximum = -Infinity;
      for (const value2 of numeric) {
        minimum = Math.min(minimum, value2);
        maximum = Math.max(maximum, value2);
      }
      if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
        return [];
      }
      validateInferredLogDomain(scale, minimum, maximum);
      if (minimum === maximum) {
        if (minimum === 0) {
          maximum = 1;
        } else {
          const offset = Math.abs(minimum) * 0.05 || 1;
          minimum -= offset;
          maximum += offset;
        }
      }
      if (thresholds) return [minimum, maximum];
      const stopCount = Math.max(2, scale.domain().length, scale.range().length);
      return Array.from(
        { length: stopCount },
        (_value, index) => minimum + (maximum - minimum) * index / (stopCount - 1)
      );
    }
    return uniqueChartKeys(observed);
  }
  function quantitativeColorValues(values) {
    const numeric = values.filter(
      (value2) => typeof value2 === "number" && Number.isFinite(value2)
    );
    if (numeric.length !== values.length) colorScaleTypeMismatch();
    return numeric;
  }
  function colorScaleTypeMismatch() {
    throw new TypeError(
      "A quantitative color-scale factory requires numeric values"
    );
  }
  function colorScaleKind(scale) {
    if (scale.quantiles) {
      return scale.invertExtent ? "quantile" : "continuous";
    }
    if (scale.thresholds) return "quantize";
    if (scale.invertExtent) return "threshold";
    return scale.ticks ? "continuous" : "categorical";
  }
  function valueKey(value2) {
    if (value2 instanceof Date) return `date:${value2.getTime()}`;
    if (typeof value2 === "string") return `string:${value2.length}:${value2}`;
    return `${typeof value2}:${String(value2)}`;
  }

  // node_modules/@tanstack/charts/dist/mark.js
  var warnedKeyFallbacks = /* @__PURE__ */ new WeakSet();
  function isChartValue(value2) {
    return typeof value2 === "string" || value2 instanceof Date && Number.isFinite(value2.getTime()) || isFiniteNumber(value2);
  }
  function isFiniteNumber(value2) {
    return typeof value2 === "number" && Number.isFinite(value2);
  }
  function isNonnegativeFiniteNumber(value2) {
    return isFiniteNumber(value2) && value2 >= 0;
  }
  function createMark(initialize, motion, renderer) {
    const normalizedInitialize = (context) => {
      const initialized = normalizeMarkInitialization(initialize(context));
      const withMotion = motion === void 0 || initialized.motion !== void 0 ? initialized : { ...initialized, motion };
      return renderer === void 0 ? withMotion : applyMarkRenderer(withMotion, renderer);
    };
    return {
      initialize: normalizedInitialize,
      ...motion === void 0 ? {} : { motion },
      ...renderer === void 0 ? {} : { renderer }
    };
  }
  function applyMarkRenderer(initialized, renderer) {
    const render = initialized.render;
    const resolveLayout = initialized.resolveLayout;
    return {
      ...initialized,
      render: (context) => applyMarkRendererToScene(render(context), renderer),
      ...resolveLayout ? {
        resolveLayout(context) {
          const resolved = resolveLayout(context);
          return {
            ...resolved,
            render: (renderContext) => applyMarkRendererToScene(
              resolved.render(renderContext),
              renderer
            )
          };
        }
      } : {}
    };
  }
  function applyMarkRendererToScene(scene, renderer) {
    return {
      ...scene,
      nodes: scene.nodes.map((node) => ({ ...node, renderer })),
      ...scene.focusGuides ? {
        focusGuides: scene.focusGuides.map((guide) => ({
          ...guide,
          renderer
        }))
      } : {}
    };
  }
  function normalizeMarkInitialization(initialized) {
    if (typeof initialized.render === "function") return initialized;
    return {
      ...initialized,
      render: () => {
        throw new TypeError(
          `Mark "${initialized.id}" must resolve its layout before rendering`
        );
      }
    };
  }
  function markStates(data, definitions) {
    return definitions?.length ? {
      data,
      definitions
    } : void 0;
  }
  function visualValue(channel, datum, index, data, fallback) {
    return typeof channel === "function" ? channel(datum, { index, data }) : channel ?? fallback;
  }
  function channelValues(data, channel, fallback) {
    if (typeof channel === "function") {
      return data.map((datum, index) => channel(datum, { index, data }));
    }
    if (channel !== void 0) {
      return data.map(
        (datum) => datum != null && typeof datum === "object" ? datum[channel] : void 0
      );
    }
    return data.map((datum, index) => fallback(datum, { index, data }));
  }
  function inferredKeyValues(data, key, options = {}) {
    if (key !== void 0) {
      return channelValues(data, key, (_datum, { index }) => index);
    }
    const candidates = [
      data.map(
        (datum) => datum != null && typeof datum === "object" ? datum.id : void 0
      ),
      data.map((datum) => {
        if (datum == null || typeof datum !== "object") return void 0;
        const nested = datum.data;
        return nested != null && typeof nested === "object" ? nested.id : void 0;
      }),
      ...options.candidates ?? []
    ];
    for (const candidate of candidates) {
      if (candidate.length !== data.length) continue;
      const normalized = candidate.map(normalizeInferredKey);
      if (normalized.every((value2) => value2 !== void 0) && keysAreUniqueWithinGroups(normalized, options.groups)) {
        return normalized;
      }
    }
    warnAboutKeyFallback(
      options.markId,
      options.candidates,
      options.warningIdentity
    );
    return data.map((_datum, index) => index);
  }
  function compositeKeyValues(...channels) {
    const length = channels[0]?.length ?? 0;
    return Array.from({ length }, (_value, index) => {
      const parts = channels.map(
        (channel) => normalizeInferredKey(channel[index])
      );
      return parts.every((part) => part !== void 0) ? JSON.stringify(parts.map(valueKey)) : void 0;
    });
  }
  function normalizeInferredKey(value2) {
    if (isChartKey(value2)) return value2;
    if (value2 instanceof Date && Number.isFinite(value2.getTime())) {
      return `date:${value2.getTime()}`;
    }
    return void 0;
  }
  function keysAreUniqueWithinGroups(keys, groups) {
    const seen = /* @__PURE__ */ new Set();
    for (let index = 0; index < keys.length; index += 1) {
      const identity = JSON.stringify([
        valueKey(groups?.[index] ?? null),
        valueKey(keys[index])
      ]);
      if (seen.has(identity)) return false;
      seen.add(identity);
    }
    return true;
  }
  function warnAboutKeyFallback(markId, candidates, warningIdentity) {
    if (!markId || !candidates?.length || !warningIdentity || warnedKeyFallbacks.has(warningIdentity) || typeof process === "undefined" || false) {
      return;
    }
    warnedKeyFallbacks.add(warningIdentity);
    console.warn(
      `TanStack Charts could not infer a unique key for mark "${markId}". Using row position; supply key for stable identity across updates.`
    );
  }

  // node_modules/d3-shape/src/constant.js
  function constant_default(x2) {
    return function constant2() {
      return x2;
    };
  }

  // node_modules/d3-shape/src/math.js
  var abs = Math.abs;
  var atan2 = Math.atan2;
  var cos = Math.cos;
  var max = Math.max;
  var min = Math.min;
  var sin = Math.sin;
  var sqrt = Math.sqrt;
  var epsilon = 1e-12;
  var pi = Math.PI;
  var halfPi = pi / 2;
  var tau = 2 * pi;
  function acos(x2) {
    return x2 > 1 ? 0 : x2 < -1 ? pi : Math.acos(x2);
  }
  function asin(x2) {
    return x2 >= 1 ? halfPi : x2 <= -1 ? -halfPi : Math.asin(x2);
  }

  // node_modules/d3-path/src/path.js
  var pi2 = Math.PI;
  var tau2 = 2 * pi2;
  var epsilon2 = 1e-6;
  var tauEpsilon = tau2 - epsilon2;
  function append(strings) {
    this._ += strings[0];
    for (let i = 1, n = strings.length; i < n; ++i) {
      this._ += arguments[i] + strings[i];
    }
  }
  function appendRound(digits) {
    let d = Math.floor(digits);
    if (!(d >= 0)) throw new Error(`invalid digits: ${digits}`);
    if (d > 15) return append;
    const k = 10 ** d;
    return function(strings) {
      this._ += strings[0];
      for (let i = 1, n = strings.length; i < n; ++i) {
        this._ += Math.round(arguments[i] * k) / k + strings[i];
      }
    };
  }
  var Path = class {
    constructor(digits) {
      this._x0 = this._y0 = // start of current subpath
      this._x1 = this._y1 = null;
      this._ = "";
      this._append = digits == null ? append : appendRound(digits);
    }
    moveTo(x2, y2) {
      this._append`M${this._x0 = this._x1 = +x2},${this._y0 = this._y1 = +y2}`;
    }
    closePath() {
      if (this._x1 !== null) {
        this._x1 = this._x0, this._y1 = this._y0;
        this._append`Z`;
      }
    }
    lineTo(x2, y2) {
      this._append`L${this._x1 = +x2},${this._y1 = +y2}`;
    }
    quadraticCurveTo(x1, y1, x2, y2) {
      this._append`Q${+x1},${+y1},${this._x1 = +x2},${this._y1 = +y2}`;
    }
    bezierCurveTo(x1, y1, x2, y2, x3, y3) {
      this._append`C${+x1},${+y1},${+x2},${+y2},${this._x1 = +x3},${this._y1 = +y3}`;
    }
    arcTo(x1, y1, x2, y2, r) {
      x1 = +x1, y1 = +y1, x2 = +x2, y2 = +y2, r = +r;
      if (r < 0) throw new Error(`negative radius: ${r}`);
      let x0 = this._x1, y0 = this._y1, x21 = x2 - x1, y21 = y2 - y1, x01 = x0 - x1, y01 = y0 - y1, l01_2 = x01 * x01 + y01 * y01;
      if (this._x1 === null) {
        this._append`M${this._x1 = x1},${this._y1 = y1}`;
      } else if (!(l01_2 > epsilon2)) ;
      else if (!(Math.abs(y01 * x21 - y21 * x01) > epsilon2) || !r) {
        this._append`L${this._x1 = x1},${this._y1 = y1}`;
      } else {
        let x20 = x2 - x0, y20 = y2 - y0, l21_2 = x21 * x21 + y21 * y21, l20_2 = x20 * x20 + y20 * y20, l21 = Math.sqrt(l21_2), l01 = Math.sqrt(l01_2), l = r * Math.tan((pi2 - Math.acos((l21_2 + l01_2 - l20_2) / (2 * l21 * l01))) / 2), t01 = l / l01, t21 = l / l21;
        if (Math.abs(t01 - 1) > epsilon2) {
          this._append`L${x1 + t01 * x01},${y1 + t01 * y01}`;
        }
        this._append`A${r},${r},0,0,${+(y01 * x20 > x01 * y20)},${this._x1 = x1 + t21 * x21},${this._y1 = y1 + t21 * y21}`;
      }
    }
    arc(x2, y2, r, a0, a1, ccw) {
      x2 = +x2, y2 = +y2, r = +r, ccw = !!ccw;
      if (r < 0) throw new Error(`negative radius: ${r}`);
      let dx = r * Math.cos(a0), dy = r * Math.sin(a0), x0 = x2 + dx, y0 = y2 + dy, cw = 1 ^ ccw, da = ccw ? a0 - a1 : a1 - a0;
      if (this._x1 === null) {
        this._append`M${x0},${y0}`;
      } else if (Math.abs(this._x1 - x0) > epsilon2 || Math.abs(this._y1 - y0) > epsilon2) {
        this._append`L${x0},${y0}`;
      }
      if (!r) return;
      if (da < 0) da = da % tau2 + tau2;
      if (da > tauEpsilon) {
        this._append`A${r},${r},0,1,${cw},${x2 - dx},${y2 - dy}A${r},${r},0,1,${cw},${this._x1 = x0},${this._y1 = y0}`;
      } else if (da > epsilon2) {
        this._append`A${r},${r},0,${+(da >= pi2)},${cw},${this._x1 = x2 + r * Math.cos(a1)},${this._y1 = y2 + r * Math.sin(a1)}`;
      }
    }
    rect(x2, y2, w, h) {
      this._append`M${this._x0 = this._x1 = +x2},${this._y0 = this._y1 = +y2}h${w = +w}v${+h}h${-w}Z`;
    }
    toString() {
      return this._;
    }
  };
  function path() {
    return new Path();
  }
  path.prototype = Path.prototype;

  // node_modules/d3-shape/src/path.js
  function withPath(shape) {
    let digits = 3;
    shape.digits = function(_) {
      if (!arguments.length) return digits;
      if (_ == null) {
        digits = null;
      } else {
        const d = Math.floor(_);
        if (!(d >= 0)) throw new RangeError(`invalid digits: ${_}`);
        digits = d;
      }
      return shape;
    };
    return () => new Path(digits);
  }

  // node_modules/d3-shape/src/arc.js
  function arcInnerRadius(d) {
    return d.innerRadius;
  }
  function arcOuterRadius(d) {
    return d.outerRadius;
  }
  function arcStartAngle(d) {
    return d.startAngle;
  }
  function arcEndAngle(d) {
    return d.endAngle;
  }
  function arcPadAngle(d) {
    return d && d.padAngle;
  }
  function intersect(x0, y0, x1, y1, x2, y2, x3, y3) {
    var x10 = x1 - x0, y10 = y1 - y0, x32 = x3 - x2, y32 = y3 - y2, t = y32 * x10 - x32 * y10;
    if (t * t < epsilon) return;
    t = (x32 * (y0 - y2) - y32 * (x0 - x2)) / t;
    return [x0 + t * x10, y0 + t * y10];
  }
  function cornerTangents(x0, y0, x1, y1, r1, rc, cw) {
    var x01 = x0 - x1, y01 = y0 - y1, lo = (cw ? rc : -rc) / sqrt(x01 * x01 + y01 * y01), ox = lo * y01, oy = -lo * x01, x11 = x0 + ox, y11 = y0 + oy, x10 = x1 + ox, y10 = y1 + oy, x00 = (x11 + x10) / 2, y00 = (y11 + y10) / 2, dx = x10 - x11, dy = y10 - y11, d2 = dx * dx + dy * dy, r = r1 - rc, D = x11 * y10 - x10 * y11, d = (dy < 0 ? -1 : 1) * sqrt(max(0, r * r * d2 - D * D)), cx0 = (D * dy - dx * d) / d2, cy0 = (-D * dx - dy * d) / d2, cx1 = (D * dy + dx * d) / d2, cy1 = (-D * dx + dy * d) / d2, dx0 = cx0 - x00, dy0 = cy0 - y00, dx1 = cx1 - x00, dy1 = cy1 - y00;
    if (dx0 * dx0 + dy0 * dy0 > dx1 * dx1 + dy1 * dy1) cx0 = cx1, cy0 = cy1;
    return {
      cx: cx0,
      cy: cy0,
      x01: -ox,
      y01: -oy,
      x11: cx0 * (r1 / r - 1),
      y11: cy0 * (r1 / r - 1)
    };
  }
  function arc_default() {
    var innerRadius = arcInnerRadius, outerRadius = arcOuterRadius, cornerRadius = constant_default(0), padRadius = null, startAngle = arcStartAngle, endAngle = arcEndAngle, padAngle = arcPadAngle, context = null, path2 = withPath(arc);
    function arc() {
      var buffer, r, r0 = +innerRadius.apply(this, arguments), r1 = +outerRadius.apply(this, arguments), a0 = startAngle.apply(this, arguments) - halfPi, a1 = endAngle.apply(this, arguments) - halfPi, da = abs(a1 - a0), cw = a1 > a0;
      if (!context) context = buffer = path2();
      if (r1 < r0) r = r1, r1 = r0, r0 = r;
      if (!(r1 > epsilon)) context.moveTo(0, 0);
      else if (da > tau - epsilon) {
        context.moveTo(r1 * cos(a0), r1 * sin(a0));
        context.arc(0, 0, r1, a0, a1, !cw);
        if (r0 > epsilon) {
          context.moveTo(r0 * cos(a1), r0 * sin(a1));
          context.arc(0, 0, r0, a1, a0, cw);
        }
      } else {
        var a01 = a0, a11 = a1, a00 = a0, a10 = a1, da0 = da, da1 = da, ap = padAngle.apply(this, arguments) / 2, rp = ap > epsilon && (padRadius ? +padRadius.apply(this, arguments) : sqrt(r0 * r0 + r1 * r1)), rc = min(abs(r1 - r0) / 2, +cornerRadius.apply(this, arguments)), rc0 = rc, rc1 = rc, t0, t1;
        if (rp > epsilon) {
          var p0 = asin(rp / r0 * sin(ap)), p1 = asin(rp / r1 * sin(ap));
          if ((da0 -= p0 * 2) > epsilon) p0 *= cw ? 1 : -1, a00 += p0, a10 -= p0;
          else da0 = 0, a00 = a10 = (a0 + a1) / 2;
          if ((da1 -= p1 * 2) > epsilon) p1 *= cw ? 1 : -1, a01 += p1, a11 -= p1;
          else da1 = 0, a01 = a11 = (a0 + a1) / 2;
        }
        var x01 = r1 * cos(a01), y01 = r1 * sin(a01), x10 = r0 * cos(a10), y10 = r0 * sin(a10);
        if (rc > epsilon) {
          var x11 = r1 * cos(a11), y11 = r1 * sin(a11), x00 = r0 * cos(a00), y00 = r0 * sin(a00), oc;
          if (da < pi) {
            if (oc = intersect(x01, y01, x00, y00, x11, y11, x10, y10)) {
              var ax = x01 - oc[0], ay = y01 - oc[1], bx = x11 - oc[0], by = y11 - oc[1], kc = 1 / sin(acos((ax * bx + ay * by) / (sqrt(ax * ax + ay * ay) * sqrt(bx * bx + by * by))) / 2), lc = sqrt(oc[0] * oc[0] + oc[1] * oc[1]);
              rc0 = min(rc, (r0 - lc) / (kc - 1));
              rc1 = min(rc, (r1 - lc) / (kc + 1));
            } else {
              rc0 = rc1 = 0;
            }
          }
        }
        if (!(da1 > epsilon)) context.moveTo(x01, y01);
        else if (rc1 > epsilon) {
          t0 = cornerTangents(x00, y00, x01, y01, r1, rc1, cw);
          t1 = cornerTangents(x11, y11, x10, y10, r1, rc1, cw);
          context.moveTo(t0.cx + t0.x01, t0.cy + t0.y01);
          if (rc1 < rc) context.arc(t0.cx, t0.cy, rc1, atan2(t0.y01, t0.x01), atan2(t1.y01, t1.x01), !cw);
          else {
            context.arc(t0.cx, t0.cy, rc1, atan2(t0.y01, t0.x01), atan2(t0.y11, t0.x11), !cw);
            context.arc(0, 0, r1, atan2(t0.cy + t0.y11, t0.cx + t0.x11), atan2(t1.cy + t1.y11, t1.cx + t1.x11), !cw);
            context.arc(t1.cx, t1.cy, rc1, atan2(t1.y11, t1.x11), atan2(t1.y01, t1.x01), !cw);
          }
        } else context.moveTo(x01, y01), context.arc(0, 0, r1, a01, a11, !cw);
        if (!(r0 > epsilon) || !(da0 > epsilon)) context.lineTo(x10, y10);
        else if (rc0 > epsilon) {
          t0 = cornerTangents(x10, y10, x11, y11, r0, -rc0, cw);
          t1 = cornerTangents(x01, y01, x00, y00, r0, -rc0, cw);
          context.lineTo(t0.cx + t0.x01, t0.cy + t0.y01);
          if (rc0 < rc) context.arc(t0.cx, t0.cy, rc0, atan2(t0.y01, t0.x01), atan2(t1.y01, t1.x01), !cw);
          else {
            context.arc(t0.cx, t0.cy, rc0, atan2(t0.y01, t0.x01), atan2(t0.y11, t0.x11), !cw);
            context.arc(0, 0, r0, atan2(t0.cy + t0.y11, t0.cx + t0.x11), atan2(t1.cy + t1.y11, t1.cx + t1.x11), cw);
            context.arc(t1.cx, t1.cy, rc0, atan2(t1.y11, t1.x11), atan2(t1.y01, t1.x01), !cw);
          }
        } else context.arc(0, 0, r0, a10, a00, cw);
      }
      context.closePath();
      if (buffer) return context = null, buffer + "" || null;
    }
    arc.centroid = function() {
      var r = (+innerRadius.apply(this, arguments) + +outerRadius.apply(this, arguments)) / 2, a = (+startAngle.apply(this, arguments) + +endAngle.apply(this, arguments)) / 2 - pi / 2;
      return [cos(a) * r, sin(a) * r];
    };
    arc.innerRadius = function(_) {
      return arguments.length ? (innerRadius = typeof _ === "function" ? _ : constant_default(+_), arc) : innerRadius;
    };
    arc.outerRadius = function(_) {
      return arguments.length ? (outerRadius = typeof _ === "function" ? _ : constant_default(+_), arc) : outerRadius;
    };
    arc.cornerRadius = function(_) {
      return arguments.length ? (cornerRadius = typeof _ === "function" ? _ : constant_default(+_), arc) : cornerRadius;
    };
    arc.padRadius = function(_) {
      return arguments.length ? (padRadius = _ == null ? null : typeof _ === "function" ? _ : constant_default(+_), arc) : padRadius;
    };
    arc.startAngle = function(_) {
      return arguments.length ? (startAngle = typeof _ === "function" ? _ : constant_default(+_), arc) : startAngle;
    };
    arc.endAngle = function(_) {
      return arguments.length ? (endAngle = typeof _ === "function" ? _ : constant_default(+_), arc) : endAngle;
    };
    arc.padAngle = function(_) {
      return arguments.length ? (padAngle = typeof _ === "function" ? _ : constant_default(+_), arc) : padAngle;
    };
    arc.context = function(_) {
      return arguments.length ? (context = _ == null ? null : _, arc) : context;
    };
    return arc;
  }

  // node_modules/d3-shape/src/array.js
  var slice = Array.prototype.slice;
  function array_default(x2) {
    return typeof x2 === "object" && "length" in x2 ? x2 : Array.from(x2);
  }

  // node_modules/d3-shape/src/curve/linear.js
  function Linear(context) {
    this._context = context;
  }
  Linear.prototype = {
    areaStart: function() {
      this._line = 0;
    },
    areaEnd: function() {
      this._line = NaN;
    },
    lineStart: function() {
      this._point = 0;
    },
    lineEnd: function() {
      if (this._line || this._line !== 0 && this._point === 1) this._context.closePath();
      this._line = 1 - this._line;
    },
    point: function(x2, y2) {
      x2 = +x2, y2 = +y2;
      switch (this._point) {
        case 0:
          this._point = 1;
          this._line ? this._context.lineTo(x2, y2) : this._context.moveTo(x2, y2);
          break;
        case 1:
          this._point = 2;
        // falls through
        default:
          this._context.lineTo(x2, y2);
          break;
      }
    }
  };
  function linear_default(context) {
    return new Linear(context);
  }

  // node_modules/d3-shape/src/point.js
  function x(p) {
    return p[0];
  }
  function y(p) {
    return p[1];
  }

  // node_modules/d3-shape/src/line.js
  function line_default(x2, y2) {
    var defined = constant_default(true), context = null, curve = linear_default, output = null, path2 = withPath(line);
    x2 = typeof x2 === "function" ? x2 : x2 === void 0 ? x : constant_default(x2);
    y2 = typeof y2 === "function" ? y2 : y2 === void 0 ? y : constant_default(y2);
    function line(data) {
      var i, n = (data = array_default(data)).length, d, defined0 = false, buffer;
      if (context == null) output = curve(buffer = path2());
      for (i = 0; i <= n; ++i) {
        if (!(i < n && defined(d = data[i], i, data)) === defined0) {
          if (defined0 = !defined0) output.lineStart();
          else output.lineEnd();
        }
        if (defined0) output.point(+x2(d, i, data), +y2(d, i, data));
      }
      if (buffer) return output = null, buffer + "" || null;
    }
    line.x = function(_) {
      return arguments.length ? (x2 = typeof _ === "function" ? _ : constant_default(+_), line) : x2;
    };
    line.y = function(_) {
      return arguments.length ? (y2 = typeof _ === "function" ? _ : constant_default(+_), line) : y2;
    };
    line.defined = function(_) {
      return arguments.length ? (defined = typeof _ === "function" ? _ : constant_default(!!_), line) : defined;
    };
    line.curve = function(_) {
      return arguments.length ? (curve = _, context != null && (output = curve(context)), line) : curve;
    };
    line.context = function(_) {
      return arguments.length ? (_ == null ? context = output = null : output = curve(context = _), line) : context;
    };
    return line;
  }

  // node_modules/d3-shape/src/area.js
  function area_default(x0, y0, y1) {
    var x1 = null, defined = constant_default(true), context = null, curve = linear_default, output = null, path2 = withPath(area);
    x0 = typeof x0 === "function" ? x0 : x0 === void 0 ? x : constant_default(+x0);
    y0 = typeof y0 === "function" ? y0 : y0 === void 0 ? constant_default(0) : constant_default(+y0);
    y1 = typeof y1 === "function" ? y1 : y1 === void 0 ? y : constant_default(+y1);
    function area(data) {
      var i, j, k, n = (data = array_default(data)).length, d, defined0 = false, buffer, x0z = new Array(n), y0z = new Array(n);
      if (context == null) output = curve(buffer = path2());
      for (i = 0; i <= n; ++i) {
        if (!(i < n && defined(d = data[i], i, data)) === defined0) {
          if (defined0 = !defined0) {
            j = i;
            output.areaStart();
            output.lineStart();
          } else {
            output.lineEnd();
            output.lineStart();
            for (k = i - 1; k >= j; --k) {
              output.point(x0z[k], y0z[k]);
            }
            output.lineEnd();
            output.areaEnd();
          }
        }
        if (defined0) {
          x0z[i] = +x0(d, i, data), y0z[i] = +y0(d, i, data);
          output.point(x1 ? +x1(d, i, data) : x0z[i], y1 ? +y1(d, i, data) : y0z[i]);
        }
      }
      if (buffer) return output = null, buffer + "" || null;
    }
    function arealine() {
      return line_default().defined(defined).curve(curve).context(context);
    }
    area.x = function(_) {
      return arguments.length ? (x0 = typeof _ === "function" ? _ : constant_default(+_), x1 = null, area) : x0;
    };
    area.x0 = function(_) {
      return arguments.length ? (x0 = typeof _ === "function" ? _ : constant_default(+_), area) : x0;
    };
    area.x1 = function(_) {
      return arguments.length ? (x1 = _ == null ? null : typeof _ === "function" ? _ : constant_default(+_), area) : x1;
    };
    area.y = function(_) {
      return arguments.length ? (y0 = typeof _ === "function" ? _ : constant_default(+_), y1 = null, area) : y0;
    };
    area.y0 = function(_) {
      return arguments.length ? (y0 = typeof _ === "function" ? _ : constant_default(+_), area) : y0;
    };
    area.y1 = function(_) {
      return arguments.length ? (y1 = _ == null ? null : typeof _ === "function" ? _ : constant_default(+_), area) : y1;
    };
    area.lineX0 = area.lineY0 = function() {
      return arealine().x(x0).y(y0);
    };
    area.lineY1 = function() {
      return arealine().x(x0).y(y1);
    };
    area.lineX1 = function() {
      return arealine().x(x1).y(y0);
    };
    area.defined = function(_) {
      return arguments.length ? (defined = typeof _ === "function" ? _ : constant_default(!!_), area) : defined;
    };
    area.curve = function(_) {
      return arguments.length ? (curve = _, context != null && (output = curve(context)), area) : curve;
    };
    area.context = function(_) {
      return arguments.length ? (_ == null ? context = output = null : output = curve(context = _), area) : context;
    };
    return area;
  }

  // node_modules/d3-shape/src/curve/radial.js
  var curveRadialLinear = curveRadial(linear_default);
  function Radial(curve) {
    this._curve = curve;
  }
  Radial.prototype = {
    areaStart: function() {
      this._curve.areaStart();
    },
    areaEnd: function() {
      this._curve.areaEnd();
    },
    lineStart: function() {
      this._curve.lineStart();
    },
    lineEnd: function() {
      this._curve.lineEnd();
    },
    point: function(a, r) {
      this._curve.point(r * Math.sin(a), r * -Math.cos(a));
    }
  };
  function curveRadial(curve) {
    function radial(context) {
      return new Radial(curve(context));
    }
    radial._curve = curve;
    return radial;
  }

  // node_modules/d3-shape/src/lineRadial.js
  function lineRadial(l) {
    var c = l.curve;
    l.angle = l.x, delete l.x;
    l.radius = l.y, delete l.y;
    l.curve = function(_) {
      return arguments.length ? c(curveRadial(_)) : c()._curve;
    };
    return l;
  }
  function lineRadial_default() {
    return lineRadial(line_default().curve(curveRadialLinear));
  }

  // node_modules/d3-shape/src/areaRadial.js
  function areaRadial_default() {
    var a = area_default().curve(curveRadialLinear), c = a.curve, x0 = a.lineX0, x1 = a.lineX1, y0 = a.lineY0, y1 = a.lineY1;
    a.angle = a.x, delete a.x;
    a.startAngle = a.x0, delete a.x0;
    a.endAngle = a.x1, delete a.x1;
    a.radius = a.y, delete a.y;
    a.innerRadius = a.y0, delete a.y0;
    a.outerRadius = a.y1, delete a.y1;
    a.lineStartAngle = function() {
      return lineRadial(x0());
    }, delete a.lineX0;
    a.lineEndAngle = function() {
      return lineRadial(x1());
    }, delete a.lineX1;
    a.lineInnerRadius = function() {
      return lineRadial(y0());
    }, delete a.lineY0;
    a.lineOuterRadius = function() {
      return lineRadial(y1());
    }, delete a.lineY1;
    a.curve = function(_) {
      return arguments.length ? c(curveRadial(_)) : c()._curve;
    };
    return a;
  }

  // node_modules/d3-shape/src/pointRadial.js
  function pointRadial_default(x2, y2) {
    return [(y2 = +y2) * Math.cos(x2 -= Math.PI / 2), y2 * Math.sin(x2)];
  }

  // node_modules/d3-shape/src/noop.js
  function noop_default() {
  }

  // node_modules/d3-shape/src/curve/linearClosed.js
  function LinearClosed(context) {
    this._context = context;
  }
  LinearClosed.prototype = {
    areaStart: noop_default,
    areaEnd: noop_default,
    lineStart: function() {
      this._point = 0;
    },
    lineEnd: function() {
      if (this._point) this._context.closePath();
    },
    point: function(x2, y2) {
      x2 = +x2, y2 = +y2;
      if (this._point) this._context.lineTo(x2, y2);
      else this._point = 1, this._context.moveTo(x2, y2);
    }
  };
  function linearClosed_default(context) {
    return new LinearClosed(context);
  }

  // node_modules/d3-shape/src/curve/monotone.js
  function sign(x2) {
    return x2 < 0 ? -1 : 1;
  }
  function slope3(that, x2, y2) {
    var h0 = that._x1 - that._x0, h1 = x2 - that._x1, s0 = (that._y1 - that._y0) / (h0 || h1 < 0 && -0), s1 = (y2 - that._y1) / (h1 || h0 < 0 && -0), p = (s0 * h1 + s1 * h0) / (h0 + h1);
    return (sign(s0) + sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
  }
  function slope2(that, t) {
    var h = that._x1 - that._x0;
    return h ? (3 * (that._y1 - that._y0) / h - t) / 2 : t;
  }
  function point(that, t0, t1) {
    var x0 = that._x0, y0 = that._y0, x1 = that._x1, y1 = that._y1, dx = (x1 - x0) / 3;
    that._context.bezierCurveTo(x0 + dx, y0 + dx * t0, x1 - dx, y1 - dx * t1, x1, y1);
  }
  function MonotoneX(context) {
    this._context = context;
  }
  MonotoneX.prototype = {
    areaStart: function() {
      this._line = 0;
    },
    areaEnd: function() {
      this._line = NaN;
    },
    lineStart: function() {
      this._x0 = this._x1 = this._y0 = this._y1 = this._t0 = NaN;
      this._point = 0;
    },
    lineEnd: function() {
      switch (this._point) {
        case 2:
          this._context.lineTo(this._x1, this._y1);
          break;
        case 3:
          point(this, this._t0, slope2(this, this._t0));
          break;
      }
      if (this._line || this._line !== 0 && this._point === 1) this._context.closePath();
      this._line = 1 - this._line;
    },
    point: function(x2, y2) {
      var t1 = NaN;
      x2 = +x2, y2 = +y2;
      if (x2 === this._x1 && y2 === this._y1) return;
      switch (this._point) {
        case 0:
          this._point = 1;
          this._line ? this._context.lineTo(x2, y2) : this._context.moveTo(x2, y2);
          break;
        case 1:
          this._point = 2;
          break;
        case 2:
          this._point = 3;
          point(this, slope2(this, t1 = slope3(this, x2, y2)), t1);
          break;
        default:
          point(this, this._t0, t1 = slope3(this, x2, y2));
          break;
      }
      this._x0 = this._x1, this._x1 = x2;
      this._y0 = this._y1, this._y1 = y2;
      this._t0 = t1;
    }
  };
  function MonotoneY(context) {
    this._context = new ReflectContext(context);
  }
  (MonotoneY.prototype = Object.create(MonotoneX.prototype)).point = function(x2, y2) {
    MonotoneX.prototype.point.call(this, y2, x2);
  };
  function ReflectContext(context) {
    this._context = context;
  }
  ReflectContext.prototype = {
    moveTo: function(x2, y2) {
      this._context.moveTo(y2, x2);
    },
    closePath: function() {
      this._context.closePath();
    },
    lineTo: function(x2, y2) {
      this._context.lineTo(y2, x2);
    },
    bezierCurveTo: function(x1, y1, x2, y2, x3, y3) {
      this._context.bezierCurveTo(y1, x1, y2, x2, y3, x3);
    }
  };
  function monotoneX(context) {
    return new MonotoneX(context);
  }

  // node_modules/d3-shape/src/offset/none.js
  function none_default(series, order) {
    if (!((n = series.length) > 1)) return;
    for (var i = 1, j, s0, s1 = series[order[0]], n, m = s1.length; i < n; ++i) {
      s0 = s1, s1 = series[order[i]];
      for (j = 0; j < m; ++j) {
        s1[j][1] += s1[j][0] = isNaN(s0[j][1]) ? s0[j][0] : s0[j][1];
      }
    }
  }

  // node_modules/d3-shape/src/order/none.js
  function none_default2(series) {
    var n = series.length, o = new Array(n);
    while (--n >= 0) o[n] = n;
    return o;
  }

  // node_modules/d3-shape/src/stack.js
  function stackValue(d, key) {
    return d[key];
  }
  function stackSeries(key) {
    const series = [];
    series.key = key;
    return series;
  }
  function stack_default() {
    var keys = constant_default([]), order = none_default2, offset = none_default, value2 = stackValue;
    function stack2(data) {
      var sz = Array.from(keys.apply(this, arguments), stackSeries), i, n = sz.length, j = -1, oz;
      for (const d of data) {
        for (i = 0, ++j; i < n; ++i) {
          (sz[i][j] = [0, +value2(d, sz[i].key, j, data)]).data = d;
        }
      }
      for (i = 0, oz = array_default(order(sz)); i < n; ++i) {
        sz[oz[i]].index = i;
      }
      offset(sz, oz);
      return sz;
    }
    stack2.keys = function(_) {
      return arguments.length ? (keys = typeof _ === "function" ? _ : constant_default(Array.from(_)), stack2) : keys;
    };
    stack2.value = function(_) {
      return arguments.length ? (value2 = typeof _ === "function" ? _ : constant_default(+_), stack2) : value2;
    };
    stack2.order = function(_) {
      return arguments.length ? (order = _ == null ? none_default2 : typeof _ === "function" ? _ : constant_default(Array.from(_)), stack2) : order;
    };
    stack2.offset = function(_) {
      return arguments.length ? (offset = _ == null ? none_default : _, stack2) : offset;
    };
    return stack2;
  }

  // node_modules/d3-shape/src/offset/expand.js
  function expand_default(series, order) {
    if (!((n = series.length) > 0)) return;
    for (var i, n, j = 0, m = series[0].length, y2; j < m; ++j) {
      for (y2 = i = 0; i < n; ++i) y2 += series[i][j][1] || 0;
      if (y2) for (i = 0; i < n; ++i) series[i][j][1] /= y2;
    }
    none_default(series, order);
  }

  // node_modules/d3-shape/src/offset/silhouette.js
  function silhouette_default(series, order) {
    if (!((n = series.length) > 0)) return;
    for (var j = 0, s0 = series[order[0]], n, m = s0.length; j < m; ++j) {
      for (var i = 0, y2 = 0; i < n; ++i) y2 += series[i][j][1] || 0;
      s0[j][1] += s0[j][0] = -y2 / 2;
    }
    none_default(series, order);
  }

  // node_modules/d3-shape/src/offset/wiggle.js
  function wiggle_default(series, order) {
    if (!((n = series.length) > 0) || !((m = (s0 = series[order[0]]).length) > 0)) return;
    for (var y2 = 0, j = 1, s0, m, n; j < m; ++j) {
      for (var i = 0, s1 = 0, s2 = 0; i < n; ++i) {
        var si = series[order[i]], sij0 = si[j][1] || 0, sij1 = si[j - 1][1] || 0, s3 = (sij0 - sij1) / 2;
        for (var k = 0; k < i; ++k) {
          var sk = series[order[k]], skj0 = sk[j][1] || 0, skj1 = sk[j - 1][1] || 0;
          s3 += skj0 - skj1;
        }
        s1 += sij0, s2 += s3 * sij0;
      }
      s0[j - 1][1] += s0[j - 1][0] = y2;
      if (s1) y2 -= s2 / s1;
    }
    s0[j - 1][1] += s0[j - 1][0] = y2;
    none_default(series, order);
  }

  // node_modules/d3-shape/src/order/appearance.js
  function appearance_default(series) {
    var peaks = series.map(peak);
    return none_default2(series).sort(function(a, b) {
      return peaks[a] - peaks[b];
    });
  }
  function peak(series) {
    var i = -1, j = 0, n = series.length, vi, vj = -Infinity;
    while (++i < n) if ((vi = +series[i][1]) > vj) vj = vi, j = i;
    return j;
  }

  // node_modules/d3-shape/src/order/ascending.js
  function sum(series) {
    var s = 0, i = -1, n = series.length, v;
    while (++i < n) if (v = +series[i][1]) s += v;
    return s;
  }

  // node_modules/d3-shape/src/order/insideOut.js
  function insideOut_default(series) {
    var n = series.length, i, j, sums = series.map(sum), order = appearance_default(series), top = 0, bottom = 0, tops = [], bottoms = [];
    for (i = 0; i < n; ++i) {
      j = order[i];
      if (top < bottom) {
        top += sums[j];
        tops.push(j);
      } else {
        bottom += sums[j];
        bottoms.push(j);
      }
    }
    return bottoms.reverse().concat(tops);
  }

  // node_modules/@tanstack/charts/dist/stack-internal.js
  function stackExtents(input, options = {}) {
    const anchorFraction = resolveAnchorFraction(options);
    if (input.length === 0) return /* @__PURE__ */ new Map();
    const positions = [];
    const positionIndex = /* @__PURE__ */ new Map();
    const seriesInput = [];
    const seriesSeen = /* @__PURE__ */ new Set();
    for (const row of input) {
      const positionIdentity = valueKey(row.position);
      if (!positionIndex.has(positionIdentity)) {
        positionIndex.set(positionIdentity, positions.length);
        positions.push(row.position);
      }
      const seriesIdentity = valueKey(row.series);
      if (!seriesSeen.has(seriesIdentity)) {
        seriesSeen.add(seriesIdentity);
        seriesInput.push(row.series);
      }
    }
    const rows = positions.map(
      () => /* @__PURE__ */ Object.create(null)
    );
    const sourceIndices = /* @__PURE__ */ new Map();
    for (const row of input) {
      const position = positionIndex.get(valueKey(row.position));
      const seriesIdentity = valueKey(row.series);
      const identity = `${position}:${seriesIdentity}`;
      if (sourceIndices.has(identity)) {
        throw new TypeError(
          `A stack requires at most one value for each position and series; duplicate ${String(row.position)} / ${String(row.series)}`
        );
      }
      sourceIndices.set(identity, row.index);
      rows[position][seriesIdentity] = row.value;
    }
    const insideOut = options.order === "inside-out";
    if (anchorFraction !== void 0 && input.some(({ value: value2 }) => value2 < 0)) {
      throw new TypeError("A stack anchor requires nonnegative values");
    }
    const series = orderedSeries(input, seriesInput, options.order);
    if (options.reverse && !insideOut) series.reverse();
    const identities2 = series.map(valueKey);
    const offset = options.anchor ? none_default : options.offset === "normalize" ? expand_default : options.offset === "center" ? silhouette_default : options.offset === "wiggle" ? wiggle_default : stackOffsetDivergingZeroAware;
    const generator = stack_default().keys(identities2).value((row, key) => row[key] ?? 0).offset(offset);
    if (insideOut) {
      generator.order(
        options.reverse ? (seriesValues) => insideOut_default(seriesValues).reverse() : insideOut_default
      );
    }
    const stacked = generator(rows);
    if (options.anchor && anchorFraction !== void 0) {
      translateAnchorToZero(stacked, options.anchor.series, anchorFraction);
    }
    if (options.offset === "wiggle") translateWiggleToZero(stacked);
    const output = /* @__PURE__ */ new Map();
    stacked.forEach((seriesValues) => {
      const seriesIdentity = seriesValues.key;
      seriesValues.forEach((extent, position) => {
        const sourceIndex = sourceIndices.get(`${position}:${seriesIdentity}`);
        if (sourceIndex === void 0) return;
        output.set(sourceIndex, { start: extent[0], end: extent[1] });
      });
    });
    return output;
  }
  function stackOffsetDivergingZeroAware(series, order) {
    if (series.length === 0) return;
    const negativeSide = series.map((values) => {
      let negative = false;
      let positive = false;
      for (const [start, end] of values) {
        const value2 = end - start;
        if (value2 < 0) negative = true;
        else if (value2 > 0) positive = true;
      }
      return negative && !positive;
    });
    const positionCount = series[order[0]].length;
    for (let position = 0; position < positionCount; position += 1) {
      let positiveBaseline = 0;
      let negativeBaseline = 0;
      for (const seriesIndex of order) {
        const extent = series[seriesIndex][position];
        const value2 = extent[1] - extent[0];
        if (value2 > 0) {
          extent[0] = positiveBaseline;
          extent[1] = positiveBaseline += value2;
        } else if (value2 < 0) {
          extent[1] = negativeBaseline;
          extent[0] = negativeBaseline += value2;
        } else if (value2 === 0) {
          extent[0] = extent[1] = negativeSide[seriesIndex] ? negativeBaseline : positiveBaseline;
        } else {
          extent[0] = 0;
          extent[1] = value2;
        }
      }
    }
  }
  function resolveAnchorFraction(options) {
    const anchor = options.anchor;
    if (!anchor) return void 0;
    if (options.offset !== void 0 && options.offset !== "diverging") {
      throw new TypeError(
        "A stack anchor can only be used with the diverging offset"
      );
    }
    const fraction = anchor.fraction ?? 0.5;
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
      throw new TypeError("A stack anchor fraction must be between zero and one");
    }
    return fraction;
  }
  function translateAnchorToZero(stacked, series, fraction) {
    const anchorIdentity = valueKey(series);
    const anchorSeries = stacked.find(
      (seriesValues) => seriesValues.key === anchorIdentity
    );
    if (!anchorSeries) {
      throw new TypeError(
        `Stack anchor series "${String(series)}" is not in the resolved series order`
      );
    }
    anchorSeries.forEach((anchorExtent, position) => {
      const shift = anchorExtent[0] + (anchorExtent[1] - anchorExtent[0]) * fraction;
      for (const seriesValues of stacked) {
        const extent = seriesValues[position];
        if (!extent) continue;
        extent[0] -= shift;
        extent[1] -= shift;
      }
    });
  }
  function translateWiggleToZero(stacked) {
    let baseline = Number.POSITIVE_INFINITY;
    for (const series of stacked) {
      for (const extent of series) baseline = Math.min(baseline, extent[0]);
    }
    if (!Number.isFinite(baseline) || baseline === 0) return;
    for (const series of stacked) {
      for (const extent of series) {
        extent[0] -= baseline;
        extent[1] -= baseline;
      }
    }
  }
  function stackValues(positions, values, series, options = {}, fallbackSeries = "value") {
    const input = [];
    for (let index = 0; index < positions.length; index += 1) {
      const position = positions[index];
      const value2 = values[index];
      if (!isChartValue2(position) || !isFiniteNumber2(value2)) continue;
      const seriesValue = series[index];
      input.push({
        index,
        position,
        value: value2,
        series: isChartKey2(seriesValue) ? seriesValue : fallbackSeries === "index" ? index : "value"
      });
    }
    const extents = stackExtents(input, options);
    const starts = Array.from(
      { length: positions.length },
      () => void 0
    );
    const ends = Array.from(
      { length: positions.length },
      () => void 0
    );
    for (const [index, extent] of extents) {
      starts[index] = extent.start;
      ends[index] = extent.end;
    }
    return { starts, ends };
  }
  function isChartKey2(value2) {
    return typeof value2 === "string" || typeof value2 === "number";
  }
  function isChartValue2(value2) {
    return typeof value2 === "string" || isFiniteNumber2(value2) || value2 instanceof Date && Number.isFinite(value2.getTime());
  }
  function isFiniteNumber2(value2) {
    return typeof value2 === "number" && Number.isFinite(value2);
  }
  function orderedSeries(rows, input, order) {
    if (Array.isArray(order)) {
      const explicit = [...order];
      const explicitKeys = new Set(explicit.map(valueKey));
      return [
        ...explicit,
        ...input.filter((value2) => !explicitKeys.has(valueKey(value2)))
      ];
    }
    if (order !== "ascending" && order !== "descending") return [...input];
    const totals = new Map(input.map((value2) => [valueKey(value2), 0]));
    for (const row of rows) {
      const key = valueKey(row.series);
      totals.set(key, (totals.get(key) ?? 0) + Math.abs(row.value));
    }
    return [...input].sort((left2, right2) => {
      const difference = (totals.get(valueKey(left2)) ?? 0) - (totals.get(valueKey(right2)) ?? 0);
      return order === "ascending" ? difference : -difference;
    });
  }

  // node_modules/@tanstack/charts/dist/area.js
  function areaY(source, options = {}) {
    const data = Array.isArray(source) ? source : Array.from(source);
    const xScale = options.xScale ?? "x";
    const yScale = options.yScale ?? "y";
    return createMark(
      ({ markIndex }) => {
        const id = options.id ?? `area-y-${markIndex}`;
        const xValues = channelValues(
          data,
          options.x,
          (_datum, { index }) => index
        );
        const rawY = options.y ?? options.y2;
        const rawYValues = typeof rawY === "number" ? data.map(() => rawY) : channelValues(
          data,
          rawY,
          (datum) => typeof datum === "number" ? datum : void 0
        );
        const zValues = channelValues(data, options.z, () => null);
        const colorValues = options.color === void 0 ? zValues : channelValues(data, options.color, () => null);
        const groupValues = options.z === void 0 && options.color !== void 0 ? colorValues : zValues;
        const explicitExtent = options.y1 !== void 0 || options.y2 !== void 0;
        if (explicitExtent && options.layout) {
          throw new TypeError(
            "An area with explicit y1 or y2 endpoints cannot also configure a stack layout"
          );
        }
        const stacked = explicitExtent ? void 0 : stackValues(xValues, rawYValues, groupValues, options.layout);
        const y1Values = explicitExtent ? typeof options.y1 === "number" ? data.map(() => options.y1) : channelValues(data, options.y1, () => 0) : stacked.starts;
        const y2Values = explicitExtent ? typeof options.y2 === "number" ? data.map(() => options.y2) : channelValues(data, options.y2 ?? options.y, () => void 0) : stacked.ends;
        const keys = inferredKeyValues(data, options.key, {
          groups: groupValues,
          candidates: [xValues],
          markId: id,
          warningIdentity: options
        });
        const groups = /* @__PURE__ */ new Map();
        groupValues.forEach((value2, index) => {
          const key = valueKey(value2 ?? null);
          const group2 = groups.get(key);
          if (group2) group2.push(index);
          else groups.set(key, [index]);
        });
        return {
          id,
          states: markStates(data, options.states),
          seriesFromColor: options.z === void 0 && options.color !== void 0,
          channels: {
            x: { scale: xScale, values: xValues.filter(isChartValue) },
            y: {
              scale: yScale,
              values: [
                ...y2Values.filter(isFiniteNumber),
                ...y1Values.filter(isFiniteNumber)
              ],
              includeZero: options.y1 === void 0
            },
            color: {
              scale: "color",
              values: colorValues.filter(isChartKey)
            }
          },
          render: ({ scales, color: resolveColor }) => {
            const nodes = [];
            for (const [groupKey, indices] of groups) {
              const firstIndex = indices[0];
              if (firstIndex === void 0) continue;
              const group2 = groupValues[firstIndex] ?? null;
              const datum = data[firstIndex];
              const resolvedColor = resolveColor(colorValues[firstIndex] ?? null);
              const fill = visualValue(
                options.fill,
                datum,
                firstIndex,
                data,
                resolvedColor
              );
              const stroke = options.stroke === void 0 ? void 0 : visualValue(
                options.stroke,
                datum,
                firstIndex,
                data,
                resolvedColor
              );
              let top = [];
              let bottom = [];
              let segmentPoints = [];
              let segmentIndex = 0;
              const flush = () => {
                if (!top.length) return;
                const lower = [...bottom].reverse();
                const path2 = options.curve?.area(top, bottom);
                nodes.push({
                  kind: "area",
                  key: `${id}:${groupKey}:segment:${segmentIndex}`,
                  points: [...top, ...lower],
                  path: path2,
                  interaction: { points: segmentPoints, affinity: "x" },
                  style: {
                    fill,
                    fillOpacity: options.fillOpacity ?? 0.2,
                    stroke,
                    strokeWidth: options.strokeWidth
                  }
                });
                top = [];
                bottom = [];
                segmentPoints = [];
                segmentIndex += 1;
              };
              for (const datumIndex of indices) {
                const xValue = xValues[datumIndex];
                const yValue = rawYValues[datumIndex];
                const y1Value = y1Values[datumIndex];
                const y2Value = y2Values[datumIndex];
                if (!isChartValue(xValue) || !isFiniteNumber(yValue) || !isFiniteNumber(y1Value) || !isFiniteNumber(y2Value)) {
                  flush();
                  continue;
                }
                const x2 = scales[xScale].map(xValue);
                const y2 = scales[yScale].map(y2Value);
                top.push([x2, y2]);
                bottom.push([x2, scales[yScale].map(y1Value)]);
                const key = `${id}:${groupKey}:${valueKey(keys[datumIndex])}`;
                const point3 = {
                  key,
                  markId: id,
                  group: group2,
                  groupLabel: group2 == null ? id : String(group2),
                  datum: data[datumIndex],
                  datumIndex,
                  xValue,
                  yValue,
                  y1Value,
                  y2Value,
                  yInterval: "difference",
                  x: x2,
                  y: y2,
                  color: fill
                };
                segmentPoints.push(point3);
              }
              flush();
            }
            return {
              nodes: [
                {
                  kind: "group",
                  key: id,
                  className: "ts-chart__area",
                  ariaHidden: true,
                  children: nodes
                }
              ]
            };
          }
        };
      },
      options.motion,
      options.renderer
    );
  }

  // node_modules/@tanstack/charts/dist/configured-scale.js
  function resolveConfiguredScale(source, context) {
    const scale = resolveScaleInput(source, {
      values: context.values,
      includeZero: context.includeZero,
      nice: context.options?.nice,
      niceCount: context.tickCount
    });
    const contentDomain = copyDomain(scale.domain());
    const viewport = resolveViewport(scale, context, contentDomain);
    const categorical = scale.bandwidth !== void 0;
    const naturalRange = categorical && context.channel === "y" ? [Math.min(...context.range), Math.max(...context.range)] : context.range;
    const range2 = context.options?.reverse ? [naturalRange[1], naturalRange[0]] : naturalRange;
    scale.range(range2);
    const domain = copyDomain(scale.domain());
    if (viewport && (!sameDomain(domain, viewport.domain) || !mapsDomainToRange(scale, viewport.domain, range2))) {
      throw new TypeError(
        `Chart viewport "${context.id}" requires independent configurable domain and range capabilities`
      );
    }
    const tickOptions = context.options?.axis === false ? void 0 : context.options?.axis?.ticks;
    const configuredTicks = tickOptions === false ? void 0 : tickOptions;
    const tickValues = configuredTicks?.values ?? scale.ticks?.(context.tickCount) ?? domain;
    const tickFormat2 = scale.tickFormat?.(context.tickCount);
    const bandwidth = scale.bandwidth?.() ?? 0;
    const map2 = (value2) => {
      const result = scale(value2);
      return result === void 0 ? Number.NaN : result + bandwidth / 2;
    };
    const invert = scale.invert ? (position) => scale.invert(position - bandwidth / 2) : void 0;
    return {
      id: context.id,
      type: categorical ? "band" : "configured",
      domain,
      map: map2,
      ...invert ? { invert } : {},
      ticks: tickValues.map((value2) => ({
        value: value2,
        position: map2(value2),
        label: configuredTicks?.format?.(value2) ?? tickFormat2?.(value2) ?? formatValue(value2)
      })),
      bandwidth,
      ...viewport ? {
        viewport: {
          contentDomain,
          domain: viewport.domain,
          translate: viewport.translate,
          map: (value2) => map2(value2) + viewport.translate
        }
      } : {}
    };
  }
  function resolveViewport(scale, context, contentDomain) {
    const viewport = context.options?.viewport;
    if (!viewport) return void 0;
    const capable = scale;
    if (scale.bandwidth !== void 0 || typeof scale.ticks !== "function" || typeof capable.invert !== "function") {
      throw new TypeError(
        `Chart viewport "${context.id}" requires a continuous numeric or temporal scale`
      );
    }
    if (typeof capable.clamp === "function" && capable.clamp() === true) {
      throw new TypeError(
        `Chart viewport "${context.id}" does not support a clamped scale`
      );
    }
    const domain = viewport.domain;
    if (domain.length !== 2 || !sameContinuousType(domain[0], domain[1])) {
      invalidViewportDomain(context.id);
    }
    const first = continuousNumber(domain[0]);
    const last = continuousNumber(domain[1]);
    if (!Number.isFinite(first) || !Number.isFinite(last) || first === last) {
      invalidViewportDomain(context.id);
    }
    validateViewportLogDomains(scale, context.id, contentDomain, domain);
    const translate = viewport.translate ?? 0;
    if (!Number.isFinite(translate)) {
      throw new TypeError(
        `Chart viewport "${context.id}" translate must be a finite number`
      );
    }
    if (sameDomain(scale.domain(), domain)) {
      configureScaleDomain(
        scale,
        [domain[1], domain[0]],
        context.id
      );
    }
    configureScaleDomain(scale, domain, context.id);
    const resolved = copyDomain(scale.domain());
    if (resolved.length !== 2 || !sameContinuousType(resolved[0], resolved[1])) {
      invalidConfigurableDomain(context.id);
    }
    return {
      domain: resolved,
      translate
    };
  }
  function configureScaleDomain(scale, domain, id) {
    const setDomain = scale.domain;
    try {
      setDomain.call(scale, [...domain]);
    } catch {
      invalidConfigurableDomain(id);
    }
    if (!sameDomain(scale.domain(), domain)) invalidConfigurableDomain(id);
  }
  function sameDomain(resolved, expected) {
    return resolved.length === expected.length && resolved.every((value2, index) => sameChartValue(value2, expected[index]));
  }
  function mapsDomainToRange(scale, domain, range2) {
    const first = scale(domain[0]);
    const last = scale(domain[1]);
    return first !== void 0 && last !== void 0 && Number.isFinite(first) && Number.isFinite(last) && Math.abs(first - range2[0]) <= 1e-6 && Math.abs(last - range2[1]) <= 1e-6;
  }
  function copyDomain(domain) {
    return domain.map(
      (value2) => value2 instanceof Date ? new Date(value2.getTime()) : value2
    );
  }
  function invalidConfigurableDomain(id) {
    throw new TypeError(
      `Chart viewport "${id}" requires a scale with a configurable domain`
    );
  }
  function validateViewportLogDomains(scale, id, contentDomain, viewportDomain) {
    if (!isLogarithmicScale(scale)) return;
    const contentSign = logarithmicDomainSign(contentDomain);
    const viewportSign = logarithmicDomainSign(viewportDomain);
    if (contentSign === void 0 || viewportSign === void 0 || contentSign !== viewportSign) {
      throw new TypeError(
        `Chart viewport "${id}" logarithmic content and viewport domains must be finite, nonzero, and stay on the same side of zero`
      );
    }
  }
  function logarithmicDomainSign(domain) {
    let sign2;
    for (const value2 of domain) {
      if (typeof value2 !== "number" || !Number.isFinite(value2) || value2 === 0) {
        return void 0;
      }
      const current = Math.sign(value2);
      if (sign2 !== void 0 && current !== sign2) return void 0;
      sign2 = current;
    }
    return sign2;
  }
  function sameContinuousType(first, last) {
    return typeof first === "number" && typeof last === "number" || first instanceof Date && last instanceof Date;
  }
  function continuousNumber(value2) {
    return value2 instanceof Date ? value2.getTime() : value2;
  }
  function sameChartValue(left2, right2) {
    return left2 instanceof Date && right2 instanceof Date ? left2.getTime() === right2.getTime() : Object.is(left2, right2);
  }
  function invalidViewportDomain(id) {
    throw new TypeError(
      `Chart viewport "${id}" domain must contain two distinct finite numbers or Dates`
    );
  }
  function formatValue(value2) {
    return value2 instanceof Date ? value2.toLocaleDateString() : String(value2);
  }

  // node_modules/@tanstack/charts/dist/guide-layout.js
  var defaultFontSize = 16;
  var defaultFontWeight = 400;
  var defaultTypography = {
    fontFamily: "sans-serif",
    fontStyle: "normal",
    fontStretch: "normal",
    letterSpacing: 0,
    direction: "inherit",
    fontScale: 1
  };
  function estimateSceneText(text2, style) {
    const fontScale = finitePositive(style.fontScale, 1);
    const fontSize = finiteNonNegative(style.fontSize, defaultFontSize) * fontScale;
    const fontWeight = finiteNonNegative(style.fontWeight, defaultFontWeight);
    const letterSpacing = finiteNumber(style.letterSpacing, 0) * fontScale;
    if (!text2 || fontSize === 0) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    let emWidth = 0;
    for (const character of text2) {
      emWidth += estimateCharacterWidth(character);
    }
    const clampedWeight = Math.min(900, Math.max(100, fontWeight));
    const weightFactor = 1 + (clampedWeight - 400) / 12500;
    const width = Math.max(
      0,
      emWidth * fontSize * weightFactor + Math.max(0, Array.from(text2).length - 1) * letterSpacing
    );
    const height = fontSize;
    const x2 = style.anchor === "middle" ? -width / 2 : style.anchor === "end" ? -width : 0;
    const y2 = style.baseline === "middle" ? -height / 2 : style.baseline === "hanging" ? 0 : -fontSize * 0.8;
    return { x: x2, y: y2, width, height };
  }
  function measureSceneLabelBounds(label, measureText = estimateSceneText) {
    const fontSize = finiteNonNegative(label.fontSize, defaultFontSize);
    const anchor = label.anchor ?? "start";
    const baseline = label.baseline ?? "auto";
    const measured = label.text.length === 0 ? { x: 0, y: 0, width: 0, height: 0 } : measureText(label.text, {
      fontSize,
      fontWeight: label.fontWeight,
      ...defaultTypography,
      anchor,
      baseline
    });
    const x2 = finiteNumber(measured.x, 0);
    const y2 = finiteNumber(measured.y, 0);
    const width = finiteNonNegative(measured.width, 0);
    const height = finiteNonNegative(measured.height, 0);
    const bounds = {
      x: label.x + x2,
      y: label.y + y2,
      width,
      height
    };
    if (!label.rotate) {
      return bounds;
    }
    return rotateBounds(bounds, label.x, label.y, label.rotate);
  }
  function withChartTextTypography(measureText = estimateSceneText, typography = {}) {
    const resolved = {
      ...defaultTypography,
      ...typography,
      fontFamily: typography.fontFamily || defaultTypography.fontFamily,
      fontStyle: typography.fontStyle || defaultTypography.fontStyle,
      fontStretch: typography.fontStretch || defaultTypography.fontStretch,
      letterSpacing: finiteNumber(typography.letterSpacing, 0),
      fontScale: finitePositive(typography.fontScale, 1)
    };
    return (text2, options) => measureText(text2, { ...options, ...resolved });
  }
  function rotateBounds(bounds, originX, originY, degrees) {
    const radians = degrees * Math.PI / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const centerX = bounds.x + bounds.width / 2 - originX;
    const centerY = bounds.y + bounds.height / 2 - originY;
    const width = Math.abs(bounds.width * cosine) + Math.abs(bounds.height * sine);
    const height = Math.abs(bounds.width * sine) + Math.abs(bounds.height * cosine);
    const rotatedCenterX = centerX * cosine - centerY * sine + originX;
    const rotatedCenterY = centerX * sine + centerY * cosine + originY;
    return {
      x: rotatedCenterX - width / 2,
      y: rotatedCenterY - height / 2,
      width,
      height
    };
  }
  function estimateCharacterWidth(character) {
    if (/\s/u.test(character)) return 0.33;
    if (/[\u0300-\u036f]/u.test(character)) return 0;
    if (/[ilI1|!.,:;'`]/u.test(character)) return 0.28;
    if (/[mwMW@#%&]/u.test(character)) return 0.9;
    if (/[A-Z]/u.test(character)) return 0.64;
    if (/[0-9]/u.test(character)) return 0.56;
    if (character.codePointAt(0) > 127) return 1;
    return 0.54;
  }
  function finiteNonNegative(value2, fallback) {
    return value2 !== void 0 && Number.isFinite(value2) && value2 >= 0 ? value2 : fallback;
  }
  function finiteNumber(value2, fallback) {
    return value2 !== void 0 && Number.isFinite(value2) ? value2 : fallback;
  }
  function finitePositive(value2, fallback) {
    return value2 !== void 0 && Number.isFinite(value2) && value2 > 0 ? value2 : fallback;
  }

  // node_modules/@tanstack/charts/dist/nearest.js
  var sceneInteractionCache = /* @__PURE__ */ new WeakMap();
  function nearestPoint(points, x2, y2, maxDistance) {
    let result;
    let resultDistance = Infinity;
    for (let index = points.length; index--; ) {
      const point3 = points[index];
      const dx = point3.x - x2;
      const dy = point3.y - y2;
      const distance = dx * dx + dy * dy;
      if (distance <= resultDistance) {
        result = point3;
        resultDistance = distance;
      }
    }
    return result && resultDistance <= Math.max(0, maxDistance) ** 2 ? result : null;
  }
  function nearestScenePoint(scene, x2, y2, maxDistance, points = scene.points) {
    const index = interactionIndex(scene);
    const allowed = points === scene.points ? void 0 : new Set(points);
    if (!index.targets.length && !index.attachedPoints.size) {
      return nearestPoint(points, x2, y2, maxDistance);
    }
    const contained = findContainingScenePoint(scene, x2, y2, points);
    if (contained) return contained.point;
    let resultPoint;
    let resultInteraction;
    let resultPrimaryDistance = Infinity;
    let resultGeometryDistance = Infinity;
    for (const target of index.targets) {
      const interaction = target.node.interaction;
      if (!hasAllowedInteractionPoint(interaction, allowed)) continue;
      const affinity = interaction.affinity ?? "xy";
      if (affinity === "geometry") continue;
      const axis = affinity === "x" ? "x" : affinity === "y" ? "y" : void 0;
      const primaryDistance = axis ? squaredAxisDistance(target.bounds, axis === "x" ? x2 : y2, axis) : distanceToTarget(target, x2, y2);
      if (primaryDistance > resultPrimaryDistance) continue;
      const geometryDistance = axis ? distanceToTarget(target, x2, y2) : primaryDistance;
      if (primaryDistance < resultPrimaryDistance || primaryDistance === resultPrimaryDistance && geometryDistance < resultGeometryDistance) {
        resultInteraction = interaction;
        resultPoint = void 0;
        resultPrimaryDistance = primaryDistance;
        resultGeometryDistance = geometryDistance;
      }
    }
    if (resultPrimaryDistance !== 0) {
      for (const point3 of points) {
        if (index.attachedPoints.has(point3)) continue;
        const dx = point3.x - x2;
        const dy = point3.y - y2;
        const distance = dx * dx + dy * dy;
        if (distance < resultPrimaryDistance) {
          resultPoint = point3;
          resultInteraction = void 0;
          resultPrimaryDistance = distance;
          resultGeometryDistance = distance;
        }
      }
    }
    if (resultPrimaryDistance > Math.max(0, maxDistance) ** 2) return null;
    const result = resultPoint ?? (resultInteraction ? bestInteractionPoint(resultInteraction, x2, y2, allowed) : void 0);
    return result ?? null;
  }
  function findContainingScenePoint(scene, x2, y2, points = scene.points) {
    const index = interactionIndex(scene);
    const allowed = points === scene.points ? void 0 : new Set(points);
    for (let targetIndex = index.targets.length; targetIndex--; ) {
      const target = index.targets[targetIndex];
      if (containsBounds(target.bounds, x2, y2) && containsTarget(target, x2, y2)) {
        const interaction = target.node.interaction;
        const point3 = bestInteractionPoint(interaction, x2, y2, allowed);
        const hasSemanticPoint = interaction.point ? true : interaction.points.length > 0;
        if (point3 || !allowed || !hasSemanticPoint) {
          return {
            point: point3
          };
        }
      }
    }
    return null;
  }
  function interactionIndex(scene) {
    const cached = sceneInteractionCache.get(scene);
    if (cached) return cached;
    const targets = [];
    const attachedPoints = /* @__PURE__ */ new Set();
    collectTargets(scene.nodes, 0, 0, void 0, targets, attachedPoints);
    const index = { targets, attachedPoints };
    sceneInteractionCache.set(scene, index);
    return index;
  }
  function collectTargets(nodes, offsetX, offsetY, clip, targets, attachedPoints) {
    for (const node of nodes) {
      if (node.kind === "group") {
        if (node.focus) continue;
        const nextOffsetX = offsetX + (node.translateX ?? 0);
        const nextOffsetY = offsetY + (node.translateY ?? 0);
        const groupClip = node.clip ? translateBounds(node.clip, nextOffsetX, nextOffsetY) : void 0;
        const nextClip = clip === null ? null : intersectBounds(clip, groupClip);
        collectTargets(
          node.children,
          nextOffsetX,
          nextOffsetY,
          nextClip,
          targets,
          attachedPoints
        );
        continue;
      }
      if (node.kind === "label" || !node.interaction) continue;
      if (node.interaction.point) attachedPoints.add(node.interaction.point);
      else {
        for (const point3 of node.interaction.points) attachedPoints.add(point3);
      }
      if (clip === null) continue;
      const localBounds = boundsForNode(node);
      if (!localBounds) continue;
      const paintedBounds2 = translateBounds(localBounds, offsetX, offsetY);
      const visibleBounds = clip ? intersectBounds(paintedBounds2, clip) : paintedBounds2;
      if (visibleBounds == null) continue;
      targets.push({
        node,
        offsetX,
        offsetY,
        bounds: visibleBounds,
        clip
      });
    }
  }
  function bestInteractionPoint(interaction, x2, y2, allowed) {
    if (interaction.point) {
      return !allowed || allowed.has(interaction.point) ? interaction.point : null;
    }
    const affinity = interaction.affinity ?? "xy";
    let result;
    let primaryDistance = Infinity;
    let secondaryDistance = Infinity;
    for (const point3 of interaction.points) {
      if (allowed && !allowed.has(point3)) continue;
      const dx = point3.x - x2;
      const dy = point3.y - y2;
      const fullDistance = dx * dx + dy * dy;
      const nextPrimary = affinity === "x" ? dx * dx : affinity === "y" ? dy * dy : fullDistance;
      if (nextPrimary < primaryDistance || nextPrimary === primaryDistance && fullDistance < secondaryDistance) {
        result = point3;
        primaryDistance = nextPrimary;
        secondaryDistance = fullDistance;
      }
    }
    return result ?? null;
  }
  function hasAllowedInteractionPoint(interaction, allowed) {
    if (!allowed) return true;
    return interaction.point ? allowed.has(interaction.point) : interaction.points.some((point3) => allowed.has(point3));
  }
  function containsTarget(target, x2, y2) {
    const localX = x2 - target.offsetX;
    const localY = y2 - target.offsetY;
    const { node } = target;
    switch (node.kind) {
      case "rect":
        return containsRoundedRect(node, localX, localY);
      case "dot": {
        const dx = localX - node.x;
        const dy = localY - node.y;
        const radius = Math.max(0, node.radius);
        return dx * dx + dy * dy <= radius * radius;
      }
      case "area":
        return node.polygons === void 0 ? containsPolygon(node.points, localX, localY) : containsPolygons(node.polygons, localX, localY);
      case "polyline":
        return squaredDistanceToPolyline(node.points, localX, localY, false) <= strokeRadius(node) ** 2;
      case "rule":
        return squaredDistanceToSegment(
          node.x1,
          node.y1,
          node.x2,
          node.y2,
          localX,
          localY
        ) <= strokeRadius(node) ** 2;
    }
  }
  function distanceToTarget(target, x2, y2) {
    const localX = x2 - target.offsetX;
    const localY = y2 - target.offsetY;
    const { node } = target;
    let distance;
    switch (node.kind) {
      case "rect":
        distance = node.radius ? squaredDistanceToRoundedRect(node, localX, localY) : squaredDistanceToBounds(node, localX, localY);
        break;
      case "dot": {
        const dx = localX - node.x;
        const dy = localY - node.y;
        const amount = Math.max(
          0,
          Math.sqrt(dx * dx + dy * dy) - Math.max(0, node.radius)
        );
        distance = amount * amount;
        break;
      }
      case "area":
        distance = node.polygons === void 0 ? squaredDistanceToPolyline(node.points, localX, localY, true) : squaredDistanceToPolygons(node.polygons, localX, localY);
        break;
      case "polyline": {
        const raw = squaredDistanceToPolyline(node.points, localX, localY, false);
        const amount = Math.max(0, Math.sqrt(raw) - strokeRadius(node));
        distance = amount * amount;
        break;
      }
      case "rule": {
        const raw = squaredDistanceToSegment(
          node.x1,
          node.y1,
          node.x2,
          node.y2,
          localX,
          localY
        );
        const amount = Math.max(0, Math.sqrt(raw) - strokeRadius(node));
        distance = amount * amount;
        break;
      }
    }
    return target.clip ? Math.max(distance, squaredDistanceToBounds(target.clip, x2, y2)) : distance;
  }
  function boundsForNode(node) {
    switch (node.kind) {
      case "rect":
        return normalizeRect(node);
      case "dot": {
        const radius = Math.max(0, node.radius);
        return {
          x: node.x - radius,
          y: node.y - radius,
          width: radius * 2,
          height: radius * 2
        };
      }
      case "area":
        return node.polygons === void 0 ? boundsFromPoints(node.points) : boundsFromPolygons(node.polygons);
      case "polyline": {
        const bounds = boundsFromPoints(node.points);
        return bounds ? expandBounds(bounds, strokeRadius(node)) : null;
      }
      case "rule":
        return expandBounds(
          {
            x: Math.min(node.x1, node.x2),
            y: Math.min(node.y1, node.y2),
            width: Math.abs(node.x2 - node.x1),
            height: Math.abs(node.y2 - node.y1)
          },
          strokeRadius(node)
        );
    }
  }
  function containsRoundedRect(node, x2, y2) {
    const bounds = normalizeRect(node);
    if (!containsBounds(bounds, x2, y2)) return false;
    const radius = Math.max(
      0,
      Math.min(node.radius ?? 0, bounds.width / 2, bounds.height / 2)
    );
    if (radius === 0 || x2 >= bounds.x + radius && x2 <= bounds.x + bounds.width - radius || y2 >= bounds.y + radius && y2 <= bounds.y + bounds.height - radius) {
      return true;
    }
    const cornerX = x2 < bounds.x + radius ? bounds.x + radius : bounds.x + bounds.width - radius;
    const cornerY = y2 < bounds.y + radius ? bounds.y + radius : bounds.y + bounds.height - radius;
    const dx = x2 - cornerX;
    const dy = y2 - cornerY;
    return dx * dx + dy * dy <= radius * radius;
  }
  function squaredDistanceToRoundedRect(node, x2, y2) {
    const bounds = normalizeRect(node);
    const halfWidth = bounds.width / 2;
    const halfHeight = bounds.height / 2;
    const radius = Math.max(0, Math.min(node.radius ?? 0, halfWidth, halfHeight));
    const offsetX = Math.abs(x2 - (bounds.x + halfWidth)) - (halfWidth - radius);
    const offsetY = Math.abs(y2 - (bounds.y + halfHeight)) - (halfHeight - radius);
    const outside = Math.sqrt(Math.max(0, offsetX) ** 2 + Math.max(0, offsetY) ** 2) - radius;
    return Math.max(0, outside) ** 2;
  }
  function containsPolygon(points, x2, y2) {
    let inside = false;
    for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
      const current = points[index];
      const prior = points[previous];
      if (current[1] > y2 !== prior[1] > y2 && x2 < (prior[0] - current[0]) * (y2 - current[1]) / (prior[1] - current[1]) + current[0]) {
        inside = !inside;
      }
    }
    return inside;
  }
  function containsPolygons(polygons, x2, y2) {
    return polygons.some(([exterior, ...holes]) => {
      if (!exterior || !containsPolygon(exterior, x2, y2)) return false;
      return !holes.some((hole) => containsPolygon(hole, x2, y2));
    });
  }
  function squaredDistanceToPolygons(polygons, x2, y2) {
    let distance = Infinity;
    for (const polygon of polygons) {
      for (const ring of polygon) {
        distance = Math.min(distance, squaredDistanceToPolyline(ring, x2, y2, true));
      }
    }
    return distance;
  }
  function squaredDistanceToPolyline(points, x2, y2, closed) {
    if (!points.length) return Infinity;
    if (points.length === 1) {
      const point3 = points[0];
      return (point3[0] - x2) ** 2 + (point3[1] - y2) ** 2;
    }
    let distance = Infinity;
    const segmentCount = closed ? points.length : Math.max(0, points.length - 1);
    for (let index = 0; index < segmentCount; index += 1) {
      const start = points[index];
      const end = points[(index + 1) % points.length];
      distance = Math.min(
        distance,
        squaredDistanceToSegment(start[0], start[1], end[0], end[1], x2, y2)
      );
    }
    return distance;
  }
  function squaredDistanceToSegment(x1, y1, x2, y2, x3, y3) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = dx * dx + dy * dy;
    const amount = length ? Math.max(0, Math.min(1, ((x3 - x1) * dx + (y3 - y1) * dy) / length)) : 0;
    const offsetX = x3 - (x1 + amount * dx);
    const offsetY = y3 - (y1 + amount * dy);
    return offsetX * offsetX + offsetY * offsetY;
  }
  function boundsFromPoints(points) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point3 of points) {
      if (!Number.isFinite(point3[0]) || !Number.isFinite(point3[1])) continue;
      minX = Math.min(minX, point3[0]);
      minY = Math.min(minY, point3[1]);
      maxX = Math.max(maxX, point3[0]);
      maxY = Math.max(maxY, point3[1]);
    }
    return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
  }
  function boundsFromPolygons(polygons) {
    return boundsFromPoints(polygons.flatMap((polygon) => polygon.flat()));
  }
  function normalizeRect(rect2) {
    return {
      x: Math.min(rect2.x, rect2.x + rect2.width),
      y: Math.min(rect2.y, rect2.y + rect2.height),
      width: Math.abs(rect2.width),
      height: Math.abs(rect2.height)
    };
  }
  function translateBounds(bounds, x2, y2) {
    const normalized = normalizeRect(bounds);
    return { ...normalized, x: normalized.x + x2, y: normalized.y + y2 };
  }
  function expandBounds(bounds, amount) {
    return {
      x: bounds.x - amount,
      y: bounds.y - amount,
      width: bounds.width + amount * 2,
      height: bounds.height + amount * 2
    };
  }
  function intersectBounds(left2, right2) {
    if (!left2) return right2;
    if (!right2) return left2;
    const x2 = Math.max(left2.x, right2.x);
    const y2 = Math.max(left2.y, right2.y);
    const rightEdge = Math.min(left2.x + left2.width, right2.x + right2.width);
    const bottomEdge = Math.min(left2.y + left2.height, right2.y + right2.height);
    return rightEdge < x2 || bottomEdge < y2 ? null : { x: x2, y: y2, width: rightEdge - x2, height: bottomEdge - y2 };
  }
  function containsBounds(bounds, x2, y2) {
    return x2 >= bounds.x && x2 <= bounds.x + bounds.width && y2 >= bounds.y && y2 <= bounds.y + bounds.height;
  }
  function squaredAxisDistance(bounds, value2, axis) {
    const start = axis === "x" ? bounds.x : bounds.y;
    const size = axis === "x" ? bounds.width : bounds.height;
    const distance = value2 < start ? start - value2 : value2 > start + size ? value2 - start - size : 0;
    return distance * distance;
  }
  function squaredDistanceToBounds(bounds, x2, y2) {
    const normalized = normalizeRect(bounds);
    const dx = x2 < normalized.x ? normalized.x - x2 : x2 > normalized.x + normalized.width ? x2 - normalized.x - normalized.width : 0;
    const dy = y2 < normalized.y ? normalized.y - y2 : y2 > normalized.y + normalized.height ? y2 - normalized.y - normalized.height : 0;
    return dx * dx + dy * dy;
  }
  function strokeRadius(node) {
    return Math.max(0, node.style?.strokeWidth ?? 1) / 2;
  }

  // node_modules/@tanstack/charts/dist/focus-coordinate-internal.js
  var mappedCoordinates = /* @__PURE__ */ new WeakMap();
  function setMappedFocusCoordinate(point3, axis, coordinate) {
    const current = mappedCoordinates.get(point3);
    if (current) {
      current[axis] = coordinate;
    } else {
      mappedCoordinates.set(point3, { [axis]: coordinate });
    }
  }
  function mappedFocusCoordinate(point3, axis) {
    return mappedCoordinates.get(point3)?.[axis] ?? point3[axis];
  }

  // node_modules/@tanstack/charts/dist/materialized-channel-internal.js
  var positionChannel = /* @__PURE__ */ Symbol();
  function readMaterializedPositionChannel(name, channel) {
    if (name === "x" || name === "y") return name;
    return channel[positionChannel];
  }
  function preserveMaterializedPositionChannel(name, channel) {
    const position = readMaterializedPositionChannel(name, channel);
    if (position === void 0) return channel;
    if (channel[positionChannel] === position) {
      return channel;
    }
    const positioned = {
      ...channel,
      [positionChannel]: position
    };
    return positioned;
  }

  // node_modules/@tanstack/charts/dist/scene-point-map.js
  function viewportTranslationChanged(previous, next) {
    return ["x", "y"].some(
      (axis) => (previous.scales[axis]?.viewport?.translate ?? 0) !== (next.scales[axis]?.viewport?.translate ?? 0)
    );
  }
  function mapScenePointReferences(nodes, mapPoint) {
    return nodes.map((node) => {
      if (node.kind === "group") {
        return {
          ...node,
          children: mapScenePointReferences(node.children, mapPoint),
          ...node.focus ? {
            focus: {
              ...node.focus,
              points: node.focus.points.map(mapPoint)
            }
          } : {},
          ...node.states ? {
            states: {
              ...node.states,
              points: node.states.points.map(mapPoint)
            }
          } : {}
        };
      }
      if (node.kind === "label" || !node.interaction) return node;
      return {
        ...node,
        interaction: node.interaction.point ? { ...node.interaction, point: mapPoint(node.interaction.point) } : {
          ...node.interaction,
          points: node.interaction.points.map(mapPoint)
        }
      };
    });
  }

  // node_modules/@tanstack/charts/dist/scene-source.js
  var chartSceneSource = /* @__PURE__ */ Symbol("chart-scene-source");

  // node_modules/@tanstack/charts/dist/scene.js
  var defaultChartTheme = {
    foreground: "currentColor",
    muted: "currentColor",
    grid: "currentColor",
    background: "transparent",
    palette: [
      "var(--ts-chart-1, #2563eb)",
      "var(--ts-chart-2, #f97316)",
      "var(--ts-chart-3, #10b981)",
      "var(--ts-chart-4, #8b5cf6)",
      "var(--ts-chart-5, #ec4899)",
      "var(--ts-chart-6, #06b6d4)"
    ]
  };
  function defineChart(definition2, options) {
    if (options) {
      return typeof definition2 === "function" ? { chart: definition2, ...options } : { ...definition2, ...options };
    }
    return typeof definition2 === "function" ? { chart: definition2 } : definition2;
  }
  function createChartScene(definition2, size, layout = {}) {
    return createChartSceneWithScaleResolver(
      definition2,
      size,
      (context) => {
        if (!context.options?.scale) {
          throw new TypeError(
            `Chart scale "${context.id}" requires a configured scale`
          );
        }
        return resolveSuppliedScale(context.options.scale, context);
      },
      layout
    );
  }
  function resolveSuppliedScale(scale, context) {
    if (typeof scale === "function") return resolveConfiguredScale(scale, context);
    if (context.options?.viewport) {
      throw new TypeError(
        `Chart viewport "${context.id}" requires a configured or inferable continuous scale`
      );
    }
    return scale.resolve(context);
  }
  function createChartSceneWithScaleResolver(definition2, size, resolveScale, layout) {
    const width = finiteSize(size.width);
    const height = finiteSize(size.height);
    const layoutOptions = {
      ...layout,
      measureText: withChartTextTypography(layout.measureText, layout.typography)
    };
    const platformTheme = {
      ...defaultChartTheme,
      ...layoutOptions.defaultTheme,
      palette: layoutOptions.defaultTheme?.palette ?? defaultChartTheme.palette
    };
    const theme = {
      ...platformTheme,
      ...definition2.theme,
      palette: definition2.theme?.palette ?? platformTheme.palette
    };
    const initialized = definition2.marks.map(
      (mark, markIndex) => mark.initialize({ markIndex })
    );
    const scaleChannels = collectPositionScaleChannels(initialized);
    const scaleDefinitions = resolveScaleDefinitions(definition2, scaleChannels);
    const resolvedLayout = resolveSceneLayout(
      definition2,
      initialized,
      width,
      height,
      theme,
      scaleDefinitions,
      resolveScale,
      layoutOptions
    );
    const {
      margin,
      chart,
      scales,
      axes: axisNodes,
      marks,
      colors,
      legend,
      legendBounds,
      positionScales,
      scaleGuides,
      gridScales
    } = resolvedLayout;
    const markEntries = [];
    const defaultFocusEntries = [];
    const points = [];
    const focusGuides = [];
    const firstBaseMarkIndex = marks.findIndex(
      (mark) => !mark.focus && !mark.focusGuideOnly
    );
    marks.forEach((mark, markIndex) => {
      const translateX = markViewportTranslation(
        mark,
        "x",
        positionScales,
        scales
      );
      const translateY = markViewportTranslation(
        mark,
        "y",
        positionScales,
        scales
      );
      const viewportX = translateX !== void 0;
      const viewportY = translateY !== void 0;
      const pointMap = /* @__PURE__ */ new Map();
      const presentPoint = (point3) => {
        const existing = pointMap.get(point3);
        if (existing) return existing;
        const presented = viewportX || viewportY ? {
          ...point3,
          x: point3.x + (translateX ?? 0),
          y: point3.y + (translateY ?? 0)
        } : point3;
        registerMappedFocusCoordinates(
          presented,
          mark,
          scales,
          translateX,
          translateY
        );
        pointMap.set(point3, presented);
        return presented;
      };
      let rendered = mark.render({
        markIndex,
        surface: { x: 0, y: 0, width, height },
        chart,
        scales,
        theme,
        color: colors.map,
        colors,
        layout: layoutOptions
      });
      if (legend?.filterMark) {
        rendered = legend.filterMark(rendered, {
          seriesFromColor: mark.seriesFromColor
        });
      }
      if (mark.postDomain) rendered = mark.postDomain(rendered);
      const renderedPoints = collectRenderedPoints(
        rendered.nodes,
        rendered.points
      );
      const renderedNodes = viewportX || viewportY ? mapScenePointReferences(rendered.nodes, presentPoint) : rendered.nodes;
      const presentedPoints = renderedPoints.map(presentPoint);
      const entryNodes = [];
      const placement = firstBaseMarkIndex < 0 || markIndex < firstBaseMarkIndex ? "under" : "over";
      for (const guide of rendered.focusGuides ?? []) {
        focusGuides.push({ ...guide, placement: guide.placement ?? placement });
      }
      if (mark.focus) {
        const retarget = mark.focus.retarget === true;
        entryNodes.push({
          kind: "group",
          key: `focus:${mark.id}`,
          className: "ts-chart__focus-layer",
          ariaHidden: true,
          focus: {
            match: mark.focus.match ?? "primary",
            anchors: rendered.focusAnchors ?? renderedPoints,
            points: presentedPoints,
            placement,
            ...retarget ? { retarget: true, candidates: renderedNodes } : {}
          },
          children: retarget ? [] : renderedNodes
        });
      } else {
        const markPoints = presentedPoints;
        if (mark.states) {
          entryNodes.push({
            kind: "group",
            key: `states:${mark.id}`,
            children: renderedNodes,
            states: {
              data: mark.states.data,
              definitions: mark.states.definitions,
              points: markPoints
            }
          });
        } else {
          for (const node of renderedNodes) entryNodes.push(node);
        }
        for (const point3 of markPoints) points.push(point3);
        if (markPoints.length) {
          defaultFocusEntries.push({
            markId: mark.id,
            points: markPoints,
            clipped: viewportX || viewportY
          });
        }
      }
      markEntries.push({
        key: mark.id,
        nodes: entryNodes,
        translateX,
        translateY
      });
    });
    const markNodes = arrangeViewportMarkNodes(markEntries, chart);
    const nodes = [
      {
        kind: "group",
        key: "marks",
        className: "ts-chart__marks",
        clip: definition2.clip ? chart : void 0,
        children: markNodes
      }
    ];
    if (gridScales.length) {
      nodes.unshift(createGrid(chart, gridScales, theme));
    }
    if (scaleGuides.length) {
      nodes.push(axisNodes);
    }
    const controls = [];
    const controlIds = /* @__PURE__ */ new Set();
    for (const control of definition2.controls ?? []) {
      if (!control.id.trim()) {
        throw new TypeError("Chart control ids must be nonempty");
      }
      if (controlIds.has(control.id)) {
        throw new TypeError(`Duplicate chart control id "${control.id}"`);
      }
      controlIds.add(control.id);
      const resolved = control.resolve({
        chart,
        scales,
        colors,
        theme,
        width,
        height
      });
      if (resolved.nodes) nodes.push(...resolved.nodes);
      if (resolved.controls) controls.push(...resolved.controls);
    }
    if (legend && legendBounds) {
      const legendContext = {
        colors,
        chart,
        bounds: legendBounds,
        theme,
        width,
        height
      };
      nodes.push(legend.render(legendContext));
      if (legend.control) controls.push(legend.control(legendContext));
    }
    const hostControlIds = /* @__PURE__ */ new Set();
    for (const control of controls) {
      const identity = `${control.extension.id}:${control.key}`;
      if (hostControlIds.has(identity)) {
        throw new TypeError(`Duplicate chart host control "${identity}"`);
      }
      hostControlIds.add(identity);
    }
    if (definition2.focus !== false && definition2.focusRing !== false && points.length) {
      for (const entry of defaultFocusEntries) {
        nodes.push({
          kind: "group",
          key: `default-focus:${entry.markId}`,
          className: "ts-chart__focus-layer ts-chart__focus-layer--default",
          ariaHidden: true,
          clip: entry.clipped ? chart : void 0,
          focus: {
            match: "primary",
            anchors: entry.points,
            points: entry.points,
            placement: "over"
          },
          children: entry.points.map((point3) => ({
            kind: "dot",
            key: point3.key,
            x: point3.x,
            y: point3.y,
            radius: 5,
            style: {
              fill: "var(--ts-chart-focus-fill, Canvas)",
              stroke: point3.color,
              strokeWidth: 2.5
            }
          }))
        });
      }
    }
    return {
      width,
      height,
      margin,
      chart,
      nodes,
      points,
      scales,
      colors,
      gradients: definition2.gradients ?? [],
      theme,
      ...controls.length ? { controls } : {},
      ...focusGuides.length ? { focusGuides } : {},
      [chartSceneSource]: [definition2, initialized]
    };
  }
  function registerMappedFocusCoordinates(point3, mark, scales, translateX, translateY) {
    register("x", point3.xValue, point3.x, translateX);
    register("y", point3.yValue, point3.y, translateY);
    function register(axis, value2, coordinate, translate) {
      const scaleId = mark.channels[axis]?.scale;
      const scale = scaleId === void 0 ? void 0 : scales[scaleId];
      if (!scale || scale.type === "none") return;
      const mapped = scale.map(value2) + (translate ?? 0);
      if (Number.isFinite(mapped) && mapped !== coordinate) {
        setMappedFocusCoordinate(point3, axis, mapped);
      }
    }
  }
  function markViewportTranslation(mark, channel, positionScales, scales) {
    const ownership = mark.viewport?.[channel];
    if (ownership === "fixed") return void 0;
    for (const positionScale of positionScales) {
      if (positionScale.channel === channel && positionScale.scale.viewport && Object.values(mark.channels).some(
        (materialized) => materialized.scale === positionScale.id
      )) {
        return positionScale.scale.viewport.translate;
      }
    }
    return ownership === "content" ? scales[channel]?.viewport?.translate : void 0;
  }
  function markUsesAnyViewport(mark, positionScales) {
    return ["x", "y"].some(
      (channel) => positionScales.some(
        (positionScale) => positionScale.channel === channel && positionScale.scale.viewport && mark.viewport?.[channel] !== "fixed" && (mark.viewport?.[channel] === "content" || Object.values(mark.channels).some(
          (materialized) => materialized.scale === positionScale.id
        ))
      )
    );
  }
  function arrangeViewportMarkNodes(entries, chart) {
    return entries.flatMap((entry) => {
      if (entry.translateX === void 0 && entry.translateY === void 0) {
        return [...entry.nodes];
      }
      return [
        {
          kind: "group",
          key: `viewport-clip:${entry.key}`,
          className: "ts-chart__viewport-clip",
          clip: chart,
          children: [
            {
              kind: "group",
              key: `viewport-content:${entry.key}`,
              className: "ts-chart__viewport-content",
              ...entry.translateX === void 0 ? {} : { translateX: entry.translateX },
              ...entry.translateY === void 0 ? {} : { translateY: entry.translateY },
              children: entry.nodes
            }
          ]
        }
      ];
    });
  }
  function findNearestPoint(scene, x2, y2, maxDistance = Infinity, points = scene.points) {
    return nearestScenePoint(scene, x2, y2, maxDistance, points);
  }
  function viewportInteractionPoints(scene, points = scene.points) {
    if (!Object.values(scene.scales).some((scale) => scale.viewport))
      return points;
    const { x: x2, y: y2, width, height } = scene.chart;
    const right2 = x2 + width;
    const bottom = y2 + height;
    const visible = points.filter(
      (point3) => !pointUsesViewportClip(scene, point3) || point3.x >= x2 && point3.x <= right2 && point3.y >= y2 && point3.y <= bottom
    );
    return visible.length === points.length ? points : visible;
  }
  function pointUsesViewportClip(scene, point3) {
    const source = scene[chartSceneSource];
    const mark = source?.[1].find((candidate) => candidate.id === point3.markId);
    if (!mark) return true;
    return ["x", "y"].some((axis) => {
      const ownership = mark.viewport?.[axis];
      if (ownership === "fixed") return false;
      if (ownership === "content" && scene.scales[axis]?.viewport) return true;
      return Object.entries(mark.channels).some(
        ([channelName, channel]) => channelName === axis && channel.scale !== void 0 && scene.scales[channel.scale]?.viewport !== void 0
      );
    });
  }
  function collectRenderedPoints(nodes, emitted) {
    const points = emitted ? [...emitted] : [];
    const seen = new Set(points);
    const visit = (children) => {
      for (const node of children) {
        if (node.kind === "group") {
          if (!node.focus) visit(node.children);
          continue;
        }
        if (node.kind === "label" || !node.interaction) continue;
        const interaction = node.interaction;
        if (interaction.point) {
          if (!seen.has(interaction.point)) {
            seen.add(interaction.point);
            points.push(interaction.point);
          }
        } else {
          for (const point3 of interaction.points) {
            if (seen.has(point3)) continue;
            seen.add(point3);
            points.push(point3);
          }
        }
      }
    };
    visit(nodes);
    return points;
  }
  function collectScaleChannels(marks, scaleId) {
    const values = [];
    let includeZero = false;
    let materialized = false;
    for (const mark of marks) {
      for (const channel of Object.values(mark.channels)) {
        if (channel.scale !== scaleId) continue;
        materialized = true;
        for (const value2 of channel.values) values.push(value2);
        includeZero ||= channel.includeZero ?? false;
      }
    }
    return { values, includeZero, materialized };
  }
  function collectPositionScaleChannels(marks) {
    const collected = /* @__PURE__ */ new Map();
    for (const mark of marks) {
      for (const [channelName, channel] of Object.entries(mark.channels)) {
        const scaleId = channel.scale;
        if (scaleId === void 0) continue;
        const positionChannel2 = readMaterializedPositionChannel(
          channelName,
          channel
        );
        if (scaleId === "color") {
          if (positionChannel2) {
            throw new TypeError('Position scales cannot use reserved ID "color"');
          }
          continue;
        }
        const current = collected.get(scaleId) ?? {
          values: [],
          includeZero: false,
          materialized: false
        };
        if (positionChannel2 && current.channel && current.channel !== positionChannel2) {
          throw new TypeError(
            `Chart scale "${scaleId}" cannot materialize both x and y channels`
          );
        }
        current.channel ??= positionChannel2;
        current.materialized ||= !mark.focusGuideOnly;
        current.includeZero ||= channel.includeZero ?? false;
        for (const value2 of channel.values) current.values.push(value2);
        collected.set(scaleId, current);
      }
    }
    return collected;
  }
  function resolveScaleDefinitions(definition2, collected) {
    const scales = definition2.scales;
    if (!scales || !Object.hasOwn(scales, "x") || !Object.hasOwn(scales, "y")) {
      throw new TypeError("Chart scales must define reserved `x` and `y` entries");
    }
    for (const scaleId of collected.keys()) {
      if (!Object.hasOwn(scales, scaleId)) {
        throw new TypeError(
          `Chart scale "${scaleId}" is used by a mark but is not configured`
        );
      }
    }
    return Object.entries(scales).map(([id, options]) => {
      if (id === "color") {
        throw new TypeError('Position scales cannot use reserved ID "color"');
      }
      const channels = collected.get(id) ?? {
        values: [],
        includeZero: false,
        materialized: false
      };
      const reservedChannel = id === "x" || id === "y" ? id : void 0;
      const configuredChannel = options?.channel;
      if (!reservedChannel && options !== null && !configuredChannel) {
        throw new TypeError(
          `Named chart scale "${id}" requires channel: "x" or channel: "y"`
        );
      }
      const channel = reservedChannel ?? configuredChannel ?? channels.channel ?? "x";
      if (configuredChannel && configuredChannel !== channel || channels.channel && channels.channel !== channel) {
        throw new TypeError(
          `Chart scale "${id}" is configured for ${channel} but is used as ${channels.channel ?? configuredChannel}`
        );
      }
      const side = options?.side ?? (channel === "x" ? "bottom" : "left");
      if (channel === "x" && side !== "top" && side !== "bottom" || channel === "y" && side !== "left" && side !== "right") {
        throw new TypeError(
          `Chart scale "${id}" uses ${channel} and cannot render an axis on the ${side} side`
        );
      }
      return { id, channel, side, options, channels };
    });
  }
  var automaticGuideInset = 4;
  var layoutPassLimit = 4;
  var layoutTolerance = 0.25;
  function resolveSceneLayout(definition2, initialized, width, height, theme, scaleDefinitions, resolveScale, layout) {
    const locks = resolveMarginLocks(definition2.margin);
    const hasGuides = definition2.guides !== false && scaleDefinitions.some(hasScaleGuide);
    const inset = hasGuides ? automaticGuideInset : 0;
    let margin = mergeMarginLocks(uniformMargin(inset), locks);
    let safeMargin = margin;
    for (let pass = 0; pass < layoutPassLimit; pass += 1) {
      const resolved2 = compileSceneLayout(margin);
      const next = measureMargin(resolved2);
      safeMargin = mergeMarginLocks(next, locks, safeMargin);
      if (marginsEqual(margin, next)) return resolved2;
      margin = next;
    }
    let resolved = compileSceneLayout(safeMargin);
    const finalMargin = mergeMarginLocks(
      measureMargin(resolved),
      locks,
      safeMargin
    );
    if (!marginsEqual(safeMargin, finalMargin)) {
      resolved = compileSceneLayout(finalMargin);
    }
    return resolved;
    function compileSceneLayout(margin2) {
      const chart = {
        x: margin2.left,
        y: margin2.top,
        width: Math.max(1, width - margin2.left - margin2.right),
        height: Math.max(1, height - margin2.top - margin2.bottom)
      };
      const scales = {};
      const resolvedScales = [];
      for (const scaleDefinition of scaleDefinitions) {
        const { id, channel, options, channels } = scaleDefinition;
        const length = channel === "x" ? chart.width : chart.height;
        const tickCount = resolveTickCount(
          options,
          length,
          channel === "x" ? 92 : 48,
          channel === "x" ? 8 : 7
        );
        const range2 = channel === "x" ? [chart.x, chart.x + chart.width] : [chart.y + chart.height, chart.y];
        const scale = options == null ? createUnusedScale(id, channels.materialized, options) : resolveScale({
          id,
          channel,
          values: channels.values,
          range: range2,
          options,
          tickCount,
          includeZero: channels.includeZero
        });
        scales[id] = scale;
        resolvedScales.push({ ...scaleDefinition, scale });
      }
      const marks = resolveMarkLayouts(initialized, {
        chart,
        scales,
        theme,
        layout
      });
      const colorChannels = collectScaleChannels(marks, "color");
      const colors = createColorScale(
        colorChannels.values,
        definition2.color,
        theme
      );
      if (colors.kind !== "categorical" && marks.some((mark) => mark.seriesFromColor)) {
        throw new TypeError(
          "A continuous color channel cannot infer series identity; supply z explicitly"
        );
      }
      const legend = colors.domain.length ? definition2.color?.legend : void 0;
      if (legend?.seriesVisible && colors.kind !== "categorical") {
        throw new TypeError(
          "An interactive color legend requires a categorical color scale"
        );
      }
      const legendHeight = legend?.height(colors.domain.length, {
        colors,
        chart,
        bounds: { x: chart.x, y: 0, width: chart.width, height: 0 },
        theme,
        width,
        height
      });
      const legendBounds = legend && legendHeight !== void 0 ? {
        x: chart.x,
        y: legend.placement === "bottom" ? height - legendHeight : 0,
        width: chart.width,
        height: legendHeight
      } : void 0;
      const scaleGuides = definition2.guides === false ? [] : resolvedScales.filter(hasScaleGuide);
      const gridScales = definition2.guides === false ? [] : resolvedScales.filter(hasScaleGrid);
      const resolvedAxes = createAxes(
        chart,
        scaleGuides,
        theme,
        width,
        layout.measureText
      );
      return {
        margin: margin2,
        chart,
        scales,
        axes: resolvedAxes.axes,
        positionScales: resolvedScales,
        scaleGuides,
        gridScales,
        guideMargin: resolvedAxes.margin,
        marks,
        colors,
        legend,
        legendBounds
      };
    }
    function measureMargin(resolved2) {
      const automatic = resolved2.guideMargin;
      if (resolved2.legend) {
        const legendHeight = resolved2.legend.height(
          resolved2.colors.domain.length,
          {
            colors: resolved2.colors,
            chart: resolved2.chart,
            bounds: {
              x: resolved2.chart.x,
              y: 0,
              width: resolved2.chart.width,
              height: 0
            },
            theme,
            width,
            height
          }
        );
        if (resolved2.legend.placement === "bottom") {
          if (locks.bottom === void 0) automatic.bottom += legendHeight;
        } else if (locks.top === void 0) {
          automatic.top = Math.max(automatic.top, legendHeight);
        }
      }
      if (!definition2.clip) {
        resolved2.marks.forEach((mark, markIndex) => {
          const autoClipped = Boolean(
            markUsesAnyViewport(mark, resolved2.positionScales)
          );
          if (autoClipped) return;
          const labels = mark.layoutLabels?.({
            markIndex,
            surface: { x: 0, y: 0, width, height },
            chart: resolved2.chart,
            scales: resolved2.scales,
            theme,
            color: resolved2.colors.map,
            colors: resolved2.colors,
            layout
          });
          for (const label of labels ?? []) {
            includeLabelMargin(
              automatic,
              resolved2.chart,
              label,
              layout.measureText
            );
          }
        });
      }
      return mergeMarginLocks(automatic, locks);
    }
  }
  function hasScaleGuide(scale) {
    return scale.options != null && scale.options.axis !== false;
  }
  function hasScaleGrid(scale) {
    return scale.options != null && scale.options.grid === true;
  }
  function resolveMarkLayouts(marks, context) {
    return marks.map((mark, markIndex) => {
      if (typeof mark.resolveLayout !== "function") {
        return mark;
      }
      const resolved = mark.resolveLayout({ ...context, markIndex });
      return {
        id: mark.id,
        channels: resolved.channels ?? mark.channels,
        viewport: mark.viewport,
        focusGuideOnly: mark.focusGuideOnly,
        seriesFromColor: mark.seriesFromColor,
        focus: mark.focus,
        states: resolved.states ?? mark.states,
        postDomain: resolved.postDomain ?? mark.postDomain,
        layoutLabels: resolved.layoutLabels ?? mark.layoutLabels,
        render: resolved.render
      };
    });
  }
  function includeLabelMargin(margin, chart, label, measureText) {
    const bounds = measureSceneLabelBounds(label, measureText);
    if (!label.text) return bounds;
    includeBoundsMargin(margin, chart, bounds);
    return bounds;
  }
  function includeBoundsMargin(margin, chart, bounds) {
    margin.top = Math.max(margin.top, chart.y - bounds.y + automaticGuideInset);
    margin.right = Math.max(
      margin.right,
      bounds.x + bounds.width - chart.x - chart.width + automaticGuideInset
    );
    margin.bottom = Math.max(
      margin.bottom,
      bounds.y + bounds.height - chart.y - chart.height + automaticGuideInset
    );
    margin.left = Math.max(margin.left, chart.x - bounds.x + automaticGuideInset);
  }
  function resolveMarginLocks(margin) {
    if (typeof margin === "number") {
      return uniformMargin(finiteMargin(margin));
    }
    if (!margin) return {};
    const locks = {};
    for (const side of marginSides) {
      if (margin[side] !== void 0) locks[side] = finiteMargin(margin[side]);
    }
    return locks;
  }
  var marginSides = ["top", "right", "bottom", "left"];
  function mergeMarginLocks(automatic, locks, previous) {
    const margin = { ...automatic };
    for (const side of marginSides) {
      margin[side] = locks[side] ?? (previous ? Math.max(previous[side], automatic[side]) : automatic[side]);
    }
    return margin;
  }
  function marginsEqual(left2, right2) {
    return marginSides.every(
      (side) => Math.abs(left2[side] - right2[side]) <= layoutTolerance
    );
  }
  function finiteMargin(value2) {
    return value2 !== void 0 && Number.isFinite(value2) ? Math.max(0, value2) : 0;
  }
  function uniformMargin(value2) {
    return { top: value2, right: value2, bottom: value2, left: value2 };
  }
  function createUnusedScale(id, materialized, axis) {
    if (materialized) {
      throw new TypeError(
        axis === null ? `Chart scale "${id}" cannot be null when a mark materializes its channel` : `Chart scale "${id}" requires a configured scale when a mark materializes its channel`
      );
    }
    return {
      id,
      type: "none",
      domain: [],
      map: () => {
        throw new TypeError(`Chart scale "${id}" is not configured`);
      },
      ticks: [],
      bandwidth: 0
    };
  }
  function createGrid(chart, guides, theme) {
    const children = [];
    for (const guide of guides) {
      if (!guide.options?.grid) continue;
      for (const tick2 of guide.scale.ticks) {
        const key = `${guide.id}-grid:${valueKey(tick2.value)}`;
        children.push(
          guide.channel === "x" ? {
            kind: "rule",
            key,
            x1: tick2.position,
            x2: tick2.position,
            y1: chart.y,
            y2: chart.y + chart.height
          } : {
            kind: "rule",
            key,
            x1: chart.x,
            x2: chart.x + chart.width,
            y1: tick2.position,
            y2: tick2.position
          }
        );
      }
    }
    return {
      kind: "group",
      key: "grid",
      className: "ts-chart__grid",
      ariaHidden: true,
      children,
      style: {
        stroke: theme.grid,
        strokeOpacity: 0.11,
        strokeWidth: 1
      }
    };
  }
  function createAxes(chart, guides, theme, width, measureText) {
    const children = [];
    const inset = guides.length ? automaticGuideInset : 0;
    const margin = uniformMargin(inset);
    const offsets = {
      top: 0,
      right: 0,
      bottom: 0,
      left: 0
    };
    const chartRight = chart.x + chart.width;
    const chartBottom = chart.y + chart.height;
    for (const guide of guides) {
      const offset = offsets[guide.side];
      margin[guide.side] = Math.max(
        margin[guide.side],
        offset + automaticGuideInset
      );
      const axisPosition = guide.side === "top" ? chart.y - offset : guide.side === "right" ? chartRight + offset : guide.side === "bottom" ? chartBottom + offset : chart.x - offset;
      let outward = axisPosition;
      const includeOutward = (bounds) => {
        includeBoundsMargin(margin, chart, bounds);
        if (guide.side === "top") outward = Math.min(outward, bounds.y);
        else if (guide.side === "right") {
          outward = Math.max(outward, bounds.x + bounds.width);
        } else if (guide.side === "bottom") {
          outward = Math.max(outward, bounds.y + bounds.height);
        } else outward = Math.min(outward, bounds.x);
      };
      const includeCoordinate = (coordinate) => {
        if (guide.side === "top" || guide.side === "left") {
          outward = Math.min(outward, coordinate);
        } else {
          outward = Math.max(outward, coordinate);
        }
      };
      if (guide.channel === "x") {
        renderXAxis(guide, axisPosition, includeOutward, includeCoordinate);
      } else {
        renderYAxis(guide, axisPosition, includeOutward, includeCoordinate);
      }
      const distance = guide.side === "top" ? chart.y - outward : guide.side === "right" ? outward - chartRight : guide.side === "bottom" ? outward - chartBottom : chart.x - outward;
      offsets[guide.side] = Math.max(offset, distance) + 8;
    }
    return {
      axes: {
        kind: "group",
        key: "axes",
        className: "ts-chart__axes",
        ariaHidden: true,
        children
      },
      margin
    };
    function renderXAxis(guide, axisY, includeOutward, includeCoordinate) {
      const presentation = axisPresentation(guide.options);
      const bottom = guide.side === "bottom";
      const direction = bottom ? 1 : -1;
      if (presentation?.line !== false) {
        children.push({
          kind: "rule",
          key: `${guide.id}-axis`,
          x1: chart.x,
          x2: chartRight,
          y1: axisY,
          y2: axisY,
          style: axisStyle()
        });
      }
      const ticks3 = presentation?.ticks === false ? [] : guide.scale.ticks;
      const tickSize = finiteMargin(
        presentation?.ticks === false ? 0 : presentation?.ticks?.size ?? 4
      );
      const tickPadding = finiteMargin(
        presentation?.ticks === false ? 0 : presentation?.ticks?.padding ?? 4
      );
      const tickLabels = tickLabelPresentation(presentation);
      const candidates = tickLabels === false ? [] : createTickLabelCandidates(
        guide,
        withKeptTicks(guide.scale, guide.options, tickLabels),
        axisY,
        tickSize,
        tickPadding,
        tickLabels,
        width,
        theme,
        measureText
      );
      const visibleLabels = tickLabels === false ? [] : thinTickLabels(candidates, tickLabels, guide.scale.type === "band");
      let tickOuter = axisY;
      for (const tick2 of ticks3) {
        if (tickSize <= 0) continue;
        const tickEnd = axisY + direction * tickSize;
        includeCoordinate(tickEnd);
        tickOuter = bottom ? Math.max(tickOuter, tickEnd) : Math.min(tickOuter, tickEnd);
        children.push({
          kind: "rule",
          key: `${guide.id}-tick-rule:${valueKey(tick2.value)}`,
          x1: tick2.position,
          x2: tick2.position,
          y1: axisY,
          y2: tickEnd,
          style: axisStyle()
        });
      }
      for (const candidate of visibleLabels) {
        includeOutward(candidate.bounds);
        tickOuter = bottom ? Math.max(tickOuter, candidate.bounds.y + candidate.bounds.height) : Math.min(tickOuter, candidate.bounds.y);
        children.push(candidate.label);
      }
      const labelText = axisLabelText(presentation);
      if (!labelText) return;
      const labelOffset = axisLabelOffset(presentation);
      const explicitOffset = labelOffset !== "auto";
      const label = {
        kind: "label",
        key: `${guide.id}-label`,
        x: chart.x + chart.width / 2,
        y: explicitOffset ? axisY + direction * Math.max(0, finiteMargin(labelOffset)) : tickOuter + direction * 8,
        text: labelText,
        anchor: "middle",
        baseline: bottom && !explicitOffset ? "hanging" : "auto",
        fontSize: width < 360 ? 10 : 11,
        fontWeight: 600,
        style: { fill: theme.foreground, fillOpacity: 0.76 }
      };
      includeOutward(measureSceneLabelBounds(label, measureText));
      children.push(label);
    }
    function renderYAxis(guide, axisX, includeOutward, includeCoordinate) {
      const presentation = axisPresentation(guide.options);
      const right2 = guide.side === "right";
      const direction = right2 ? 1 : -1;
      if (presentation?.line !== false) {
        children.push({
          kind: "rule",
          key: `${guide.id}-axis`,
          x1: axisX,
          x2: axisX,
          y1: chart.y,
          y2: chartBottom,
          style: axisStyle()
        });
      }
      const ticks3 = presentation?.ticks === false ? [] : guide.scale.ticks;
      const tickSize = finiteMargin(
        presentation?.ticks === false ? 0 : presentation?.ticks?.size ?? 4
      );
      const tickPadding = finiteMargin(
        presentation?.ticks === false ? 0 : presentation?.ticks?.padding ?? 4
      );
      const tickLabels = tickLabelPresentation(presentation);
      const candidates = tickLabels === false ? [] : createTickLabelCandidates(
        guide,
        withKeptTicks(guide.scale, guide.options, tickLabels),
        axisX,
        tickSize,
        tickPadding,
        tickLabels,
        width,
        theme,
        measureText
      );
      const visibleLabels = tickLabels === false ? [] : thinTickLabels(candidates, tickLabels, false);
      let tickOuter = axisX;
      for (const tick2 of ticks3) {
        if (tickSize <= 0) continue;
        const tickEnd = axisX + direction * tickSize;
        includeCoordinate(tickEnd);
        tickOuter = right2 ? Math.max(tickOuter, tickEnd) : Math.min(tickOuter, tickEnd);
        children.push({
          kind: "rule",
          key: `${guide.id}-tick-rule:${valueKey(tick2.value)}`,
          x1: axisX,
          x2: tickEnd,
          y1: tick2.position,
          y2: tick2.position,
          style: axisStyle()
        });
      }
      for (const candidate of visibleLabels) {
        includeOutward(candidate.bounds);
        tickOuter = right2 ? Math.max(tickOuter, candidate.bounds.x + candidate.bounds.width) : Math.min(tickOuter, candidate.bounds.x);
        children.push(candidate.label);
      }
      const labelText = axisLabelText(presentation);
      if (!labelText) return;
      const label = {
        kind: "label",
        key: `${guide.id}-label`,
        x: axisX,
        y: chart.y + chart.height / 2,
        text: labelText,
        anchor: "middle",
        baseline: "middle",
        rotate: right2 ? 90 : -90,
        fontSize: 11,
        fontWeight: 600,
        style: { fill: theme.foreground, fillOpacity: 0.76 }
      };
      const labelOffset = axisLabelOffset(presentation);
      if (labelOffset !== "auto") {
        label.x = axisX + direction * Math.max(0, finiteMargin(labelOffset));
      } else {
        const localBounds = measureSceneLabelBounds(
          { ...label, x: 0, y: 0 },
          measureText
        );
        label.x = right2 ? tickOuter + 8 - localBounds.x : tickOuter - 8 - (localBounds.x + localBounds.width);
      }
      includeOutward(measureSceneLabelBounds(label, measureText));
      children.push(label);
    }
    function axisStyle() {
      return { stroke: theme.foreground, strokeOpacity: 0.28 };
    }
  }
  function resolveTickCount(axis, length, defaultSpacing, maximum) {
    const ticks3 = axis?.axis === false ? void 0 : axis?.axis?.ticks;
    if (ticks3 === false) {
      return Math.max(2, Math.min(maximum, Math.floor(length / defaultSpacing)));
    }
    const configured = ticks3 ?? {};
    const policies = [
      configured.count !== void 0,
      configured.spacing !== void 0,
      configured.values !== void 0
    ].filter(Boolean).length;
    if (policies > 1) {
      throw new TypeError(
        "Axis ticks accept only one candidate policy: count, spacing, or values"
      );
    }
    if (configured.values) return Math.max(1, configured.values.length);
    if (configured.count !== void 0) {
      return Math.max(1, Math.floor(finiteMargin(configured.count)));
    }
    if (configured.spacing !== void 0) {
      const spacing = Math.max(1, finiteMargin(configured.spacing));
      return Math.max(1, Math.floor(length / spacing));
    }
    return Math.max(2, Math.min(maximum, Math.floor(length / defaultSpacing)));
  }
  function axisPresentation(axis) {
    if (!axis || axis.axis === false) return void 0;
    return axis.axis ?? {};
  }
  function tickLabelPresentation(axis) {
    if (axis?.ticks === false || axis?.tickLabels === false) return false;
    return axis?.tickLabels ?? {};
  }
  function axisLabelText(axis) {
    return typeof axis?.label === "string" ? axis.label : axis?.label?.text;
  }
  function axisLabelOffset(axis) {
    return typeof axis?.label === "object" ? axis.label.offset ?? "auto" : "auto";
  }
  function withKeptTicks(scale, axis, labels) {
    const thin = typeof labels.thin === "object" ? labels.thin : void 0;
    const keep = thin?.keep ?? [];
    if (!keep.length) return scale.ticks;
    const formatter2 = axis?.axis === false || axis?.axis?.ticks === false ? void 0 : axis?.axis?.ticks?.format;
    const ticks3 = scale.ticks.map((tick2) => ({
      ...tick2,
      hard: keep.some((value2) => valueKey(value2) === valueKey(tick2.value))
    }));
    const seen = new Set(ticks3.map((tick2) => valueKey(tick2.value)));
    for (const value2 of keep) {
      const position = scale.map(value2);
      if (seen.has(valueKey(value2)) || !Number.isFinite(position)) continue;
      ticks3.push({
        value: value2,
        position,
        label: formatter2?.(value2) ?? formatAxisValue(value2),
        hard: true
      });
    }
    return ticks3;
  }
  function createTickLabelCandidates(guide, ticks3, axisPosition, size, padding, options, width, theme, measureText) {
    const defaultFontSize2 = width < 360 ? 10 : 11;
    const positiveSide = guide.side === "bottom" || guide.side === "right";
    const direction = positiveSide ? 1 : -1;
    return ticks3.map((tick2, index) => {
      const context = {
        value: tick2.value,
        index,
        position: tick2.position,
        bandwidth: guide.scale.bandwidth
      };
      const rotate = options.rotate;
      const fontSize = resolveTickLabelValue(options.fontSize, context) ?? defaultFontSize2;
      const fontWeight = resolveTickLabelValue(options.fontWeight, context);
      const opacity = resolveTickLabelValue(options.opacity, context);
      const dx = resolveTickLabelValue(options.dx, context) ?? 0;
      const dy = resolveTickLabelValue(options.dy, context) ?? 0;
      const defaultAnchor = guide.channel === "y" ? positiveSide ? "start" : "end" : (rotate ?? 0) < 0 ? "end" : (rotate ?? 0) > 0 ? "start" : "middle";
      const anchor = resolveTickLabelValue(options.anchor, context) ?? defaultAnchor;
      const label = guide.channel === "x" ? {
        kind: "label",
        key: `${guide.id}-tick-label:${valueKey(tick2.value)}`,
        x: tick2.position + dx,
        y: axisPosition + direction * (size + padding + fontSize * 0.8) + dy,
        text: tick2.label,
        anchor,
        rotate,
        fontSize,
        fontWeight,
        style: {
          fill: theme.muted,
          ...opacity === void 0 ? { fillOpacity: 0.68 } : { opacity }
        }
      } : {
        kind: "label",
        key: `${guide.id}-tick-label:${valueKey(tick2.value)}`,
        x: axisPosition + direction * (size + padding) + dx,
        y: tick2.position + dy,
        text: tick2.label,
        anchor,
        baseline: "middle",
        rotate,
        fontSize,
        fontWeight,
        style: {
          fill: theme.muted,
          ...opacity === void 0 ? { fillOpacity: 0.68 } : { opacity }
        }
      };
      return {
        value: tick2.value,
        label,
        bounds: measureSceneLabelBounds(label, measureText),
        hard: tick2.hard ?? false
      };
    });
  }
  function resolveTickLabelValue(value2, context) {
    return typeof value2 === "function" ? value2(context) : value2;
  }
  function thinTickLabels(candidates, options, categoricalX) {
    if (options.thin === false || candidates.length < 2) return [...candidates];
    const thin = typeof options.thin === "object" ? options.thin : {};
    const minGap = Math.max(0, finiteMargin(thin.minGap ?? 4));
    const selected = candidates.filter(
      (candidate) => candidate.hard
    );
    const soft = candidates.filter((candidate) => !candidate.hard);
    const prioritizeEnds = thin.priority === "ends" || categoricalX;
    if (prioritizeEnds && soft.length) {
      const first = soft[0];
      const last = soft.at(-1);
      if (!collidesWithAny(first, selected, minGap)) selected.push(first);
      if (last !== first && !collidesWithAny(last, selected, minGap)) {
        selected.push(last);
      }
    }
    const ordered = distributedCandidates(
      soft.filter((candidate) => !selected.includes(candidate))
    );
    for (const candidate of ordered) {
      if (!collidesWithAny(candidate, selected, minGap)) selected.push(candidate);
    }
    const selectedSet = new Set(selected);
    return candidates.filter((candidate) => selectedSet.has(candidate));
  }
  function distributedCandidates(candidates) {
    if (candidates.length < 3) return [...candidates];
    const result = [];
    const queue = [candidates];
    while (queue.length) {
      const range2 = queue.shift();
      if (!range2.length) continue;
      const middle = Math.floor(range2.length / 2);
      result.push(range2[middle]);
      queue.push(range2.slice(0, middle), range2.slice(middle + 1));
    }
    return result;
  }
  function collidesWithAny(candidate, selected, gap) {
    return selected.some(
      (other) => boundsCollide(candidate.bounds, other.bounds, gap)
    );
  }
  function boundsCollide(left2, right2, gap) {
    return !(left2.x + left2.width + gap <= right2.x || right2.x + right2.width + gap <= left2.x || left2.y + left2.height + gap <= right2.y || right2.y + right2.height + gap <= left2.y);
  }
  function formatAxisValue(value2) {
    return value2 instanceof Date ? value2.toLocaleDateString() : String(value2);
  }
  function finiteSize(value2) {
    return Number.isFinite(value2) ? Math.max(1, value2) : 1;
  }

  // node_modules/@tanstack/charts/dist/runtime.js
  function createChartRuntime(options = {}) {
    const platformTheme = {
      ...defaultChartTheme,
      ...options.defaultTheme,
      palette: options.defaultTheme?.palette ?? defaultChartTheme.palette
    };
    return {
      render(definition2, size, layout) {
        if (!isResponsiveChartDefinition(definition2)) {
          return createChartScene(definition2, size, {
            ...layout,
            defaultTheme: platformTheme
          });
        }
        const { chart, ...options2 } = definition2;
        const spec = chart({
          width: size.width,
          height: size.height,
          defaultTheme: platformTheme
        });
        return createChartScene({ ...spec, ...options2 }, size, {
          ...layout,
          defaultTheme: platformTheme
        });
      },
      destroy() {
      }
    };
  }
  function isResponsiveChartDefinition(definition2) {
    return "chart" in definition2 && typeof definition2.chart === "function";
  }

  // node_modules/@tanstack/charts/dist/adapter-shared.js
  function resolveChartHostTabIndex(definition2, tabIndex = 0) {
    return definition2.keyboard === false || definition2.focus === false || definition2.cursor?.mode === "free" ? -1 : tabIndex;
  }

  // node_modules/@tanstack/charts/dist/dom-text.js
  function createDomTextMeasurer(container) {
    const view = container.ownerDocument.defaultView;
    const CanvasContext = view?.CanvasRenderingContext2D;
    const context = CanvasContext ? container.ownerDocument.createElement("canvas").getContext("2d") : null;
    let style = readFontStyle();
    let signature = fontSignature(style);
    const cache = /* @__PURE__ */ new Map();
    return {
      measureText(text2, options) {
        if (!context) return estimateSceneText(text2, options);
        const key = `${signature}\0${options.fontSize}\0${options.fontWeight ?? ""}\0${options.fontFamily}\0${options.fontStyle}\0${options.fontStretch}\0${options.letterSpacing}\0${options.direction}\0${options.locale ?? ""}\0${options.fontScale}\0${options.anchor}\0${options.baseline}\0${text2}`;
        const cached = cache.get(key);
        if (cached) return cached;
        configureContext(context, style.weight, options);
        const measured = context.measureText(text2);
        const metrics = paintedBounds(measured, options);
        cache.set(key, metrics);
        return metrics;
      },
      typography() {
        return {
          fontFamily: style.family,
          fontStyle: style.style,
          fontStretch: style.stretch,
          letterSpacing: style.letterSpacing,
          direction: style.direction
        };
      },
      refresh() {
        const nextStyle = readFontStyle();
        const nextSignature = fontSignature(nextStyle);
        if (nextSignature === signature) return false;
        style = nextStyle;
        signature = nextSignature;
        cache.clear();
        return true;
      },
      invalidate() {
        cache.clear();
      }
    };
    function readFontStyle() {
      const computed = view?.getComputedStyle(container);
      return {
        family: computed?.fontFamily || "sans-serif",
        style: computed?.fontStyle || "normal",
        stretch: normalizeFontStretch(computed?.fontStretch),
        weight: computed?.fontWeight || "400",
        direction: computed?.direction === "rtl" ? "rtl" : computed?.direction === "ltr" ? "ltr" : "inherit",
        letterSpacing: finiteCssPixels(computed?.letterSpacing)
      };
    }
  }
  function configureContext(context, defaultWeight, options) {
    const fontScale = positiveFinite(options.fontScale, 1);
    const fontSize = options.fontSize * fontScale;
    const weight = options.fontWeight ?? defaultWeight;
    context.font = [
      options.fontStyle,
      weight,
      `${fontSize}px`,
      options.fontFamily
    ].join(" ");
    if ("fontStretch" in context) {
      context.fontStretch = normalizeFontStretch(options.fontStretch);
    }
    context.textAlign = options.anchor === "middle" ? "center" : options.anchor;
    context.textBaseline = options.baseline === "auto" ? "alphabetic" : options.baseline;
    context.direction = options.direction;
    if ("letterSpacing" in context) {
      context.letterSpacing = `${options.letterSpacing * fontScale}px`;
    }
  }
  function paintedBounds(measured, options) {
    const fontSize = options.fontSize * positiveFinite(options.fontScale, 1);
    const left2 = measured.actualBoundingBoxLeft;
    const right2 = measured.actualBoundingBoxRight;
    const ascent = measured.actualBoundingBoxAscent;
    const descent = measured.actualBoundingBoxDescent;
    if ([left2, right2, ascent, descent].every((value2) => Number.isFinite(value2)) && (left2 + right2 > 0 || measured.width === 0) && (ascent + descent > 0 || measured.width === 0)) {
      return {
        x: -left2,
        y: -ascent,
        width: left2 + right2,
        height: ascent + descent
      };
    }
    const width = Number.isFinite(measured.width) ? Math.max(0, measured.width) : 0;
    const x2 = options.anchor === "middle" ? -width / 2 : options.anchor === "end" ? -width : 0;
    const y2 = options.baseline === "middle" ? -fontSize / 2 : options.baseline === "hanging" ? 0 : -fontSize * 0.8;
    return { x: x2, y: y2, width, height: fontSize };
  }
  function fontSignature(style) {
    return [
      style.family,
      style.style,
      style.stretch,
      style.weight,
      style.direction,
      style.letterSpacing
    ].join("\0");
  }
  function normalizeFontStretch(value2) {
    if (value2 === "ultra-condensed" || value2 === "extra-condensed" || value2 === "condensed" || value2 === "semi-condensed" || value2 === "normal" || value2 === "semi-expanded" || value2 === "expanded" || value2 === "extra-expanded" || value2 === "ultra-expanded") {
      return value2;
    }
    const percentage = Number.parseFloat(value2 ?? "");
    if (!Number.isFinite(percentage)) return "normal";
    if (percentage <= 50) return "ultra-condensed";
    if (percentage <= 62.5) return "extra-condensed";
    if (percentage <= 75) return "condensed";
    if (percentage <= 87.5) return "semi-condensed";
    if (percentage < 112.5) return "normal";
    if (percentage < 125) return "semi-expanded";
    if (percentage < 150) return "expanded";
    if (percentage < 200) return "extra-expanded";
    return "ultra-expanded";
  }
  function finiteCssPixels(value2) {
    const parsed = Number.parseFloat(value2 ?? "");
    return Number.isFinite(parsed) ? parsed : 0;
  }
  function positiveFinite(value2, fallback) {
    return value2 !== void 0 && Number.isFinite(value2) && value2 > 0 ? value2 : fallback;
  }

  // node_modules/@tanstack/charts/dist/focus-disabled.js
  var focusDisabled = {
    resolve: () => [],
    group: () => [],
    navigation: () => []
  };

  // node_modules/@tanstack/charts/dist/focus.js
  var focusGroupX = axisFocus("x", true);
  var focusGroupY = axisFocus("y", true);
  var focusNearestX = axisFocus("x", false);
  var focusNearestY = axisFocus("y", false);
  function axisFocus(axis, grouped) {
    const coordinate = (point3) => mappedFocusCoordinate(point3, axis);
    const secondary = (point3) => axis === "x" ? point3.y : point3.x;
    return {
      resolve(points, context) {
        const { x: x2, y: y2, maxDistance } = context;
        const target = axis === "x" ? x2 : y2;
        let nearest;
        let distance = maxDistance;
        for (const point3 of points) {
          const nextDistance = Math.abs(coordinate(point3) - target);
          if (nextDistance >= distance) continue;
          nearest = point3;
          distance = nextDistance;
        }
        if (!nearest) return [];
        const candidates = groupPoints(points, nearest, coordinate);
        const secondaryTarget = axis === "x" ? y2 : x2;
        const primary = candidates.reduce(
          (closest, candidate) => Math.abs(secondary(candidate) - secondaryTarget) < Math.abs(secondary(closest) - secondaryTarget) ? candidate : closest,
          nearest
        );
        return grouped ? [primary, ...candidates.filter((point3) => point3 !== primary)] : [primary];
      },
      group(points, context) {
        const { point: point3 } = context;
        return grouped ? groupPoints(points, point3, coordinate) : [point3];
      },
      navigation(points) {
        const sorted = [...points].sort(
          (left2, right2) => left2.x - right2.x || left2.y - right2.y
        );
        if (!grouped) return sorted;
        const unique = /* @__PURE__ */ new Map();
        for (const point3 of sorted) {
          const key = valueKey(coordinate(point3));
          if (!unique.has(key)) unique.set(key, point3);
        }
        return [...unique.values()];
      }
    };
  }
  function groupPoints(points, point3, coordinate) {
    const key = valueKey(coordinate(point3));
    const unique = /* @__PURE__ */ new Map();
    unique.set(valueKey(point3.group), point3);
    for (const candidate of points) {
      if (valueKey(coordinate(candidate)) !== key) continue;
      const group2 = valueKey(candidate.group);
      if (!unique.has(group2)) unique.set(group2, candidate);
    }
    const sorted = [...unique.values()].sort((left2, right2) => left2.y - right2.y);
    return [point3, ...sorted.filter((candidate) => candidate !== point3)];
  }

  // node_modules/@tanstack/charts/dist/interaction.js
  function resolveChartFocusStrategy(focus) {
    if (focus === false) return void 0;
    if (typeof focus !== "string") return focus;
    switch (focus) {
      case "nearest-x":
        return focusNearestX;
      case "nearest-y":
        return focusNearestY;
      case "group-x":
        return focusGroupX;
      case "group-y":
        return focusGroupY;
      case "nearest":
        return void 0;
    }
  }
  function resolveChartPointerFocus(scene, focusMode, x2, y2, maxDistance, points = scene.points) {
    const strategy = resolveChartFocusStrategy(focusMode);
    if (!strategy) return void 0;
    if (points === scene.points && (strategy === focusNearestX || strategy === focusNearestY || strategy === focusGroupX || strategy === focusGroupY)) {
      const contained = findContainingScenePoint(scene, x2, y2);
      if (contained) {
        return contained.point ? strategy.group(points, { point: contained.point }) : [];
      }
    }
    return strategy.resolve(points, { x: x2, y: y2, maxDistance });
  }
  function sameChartPointIdentity(left2, right2) {
    return left2 === right2 || left2 !== null && right2 !== null && left2.key === right2.key && left2.markId === right2.markId && left2.datumIndex === right2.datumIndex;
  }
  function restoreChartFocusPoint(points, previous) {
    const matches = points.filter((point3) => point3.key === previous.key);
    if (matches.length < 2) return matches[0] ?? null;
    const datumType = typeof previous.datum;
    const hasReferenceIdentity = previous.datum !== null && (datumType === "object" || datumType === "function");
    if (hasReferenceIdentity) {
      const sameDatum = matches.find((point3) => point3.datum === previous.datum);
      if (sameDatum) return sameDatum;
    }
    return matches.find(
      (point3) => point3.markId === previous.markId && Object.is(point3.group, previous.group) && sameChartValue2(point3.xValue, previous.xValue) && sameChartValue2(point3.yValue, previous.yValue)
    ) ?? matches.find(
      (point3) => point3.markId === previous.markId && point3.datumIndex === previous.datumIndex
    ) ?? matches[0] ?? null;
  }
  function chartPointFromNavigationOrder(points, current, key) {
    const currentIndex = current ? points.findIndex((point3) => sameChartPointIdentity(point3, current)) : -1;
    let nextIndex;
    switch (key) {
      case "ArrowRight":
      case "ArrowDown":
        nextIndex = Math.min(points.length - 1, currentIndex + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        nextIndex = Math.max(0, currentIndex < 0 ? 0 : currentIndex - 1);
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = points.length - 1;
        break;
      default:
        return void 0;
    }
    return points[nextIndex] ?? null;
  }
  function chartPointFromSceneOrder(points, current, key) {
    const direction = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : key === "Home" ? 0 : key === "End" ? 2 : void 0;
    if (direction === void 0) return void 0;
    if (!points.length) return null;
    const currentIndex = current ? points.findIndex((point3) => sameChartPointIdentity(point3, current)) : -1;
    if (!current || currentIndex < 0 || direction === 0 || direction === 2) {
      return navigationExtreme(points, direction === 2);
    }
    let candidate = null;
    let candidateIndex = -1;
    for (let index = 0; index < points.length; index += 1) {
      const point3 = points[index];
      if (!point3) continue;
      const relative = compareNavigationPoints(
        point3,
        index,
        current,
        currentIndex
      );
      if (direction > 0 && relative <= 0 || direction < 0 && relative >= 0) {
        continue;
      }
      if (!candidate || direction * compareNavigationPoints(point3, index, candidate, candidateIndex) < 0) {
        candidate = point3;
        candidateIndex = index;
      }
    }
    return candidate ?? current;
  }
  function navigationExtreme(points, maximum) {
    let candidate = points[0] ?? null;
    let candidateIndex = 0;
    for (let index = 1; index < points.length; index += 1) {
      const point3 = points[index];
      if (!point3 || !candidate) continue;
      const comparison = compareNavigationPoints(
        point3,
        index,
        candidate,
        candidateIndex
      );
      if (maximum && comparison > 0 || !maximum && comparison < 0) {
        candidate = point3;
        candidateIndex = index;
      }
    }
    return candidate;
  }
  function compareNavigationPoints(left2, leftIndex, right2, rightIndex) {
    return left2.x - right2.x || left2.y - right2.y || leftIndex - rightIndex;
  }
  function sameChartValue2(left2, right2) {
    return left2 instanceof Date && right2 instanceof Date ? left2.getTime() === right2.getTime() : Object.is(left2, right2);
  }

  // node_modules/@tanstack/charts/dist/cursor-host-contract.js
  function createChartCursorHostSession(binding) {
    const extension = binding.use;
    if (extension.__chartExtensionType !== "cursor") {
      throw new TypeError("A chart cursor requires a cursor host extension.");
    }
    return extension.create(binding.controller);
  }

  // node_modules/@tanstack/charts/dist/renderer.js
  function resolveChartRenderer(scene, defaultRenderer) {
    const renderer = findLayerRenderer(scene.nodes, defaultRenderer) ?? findGuideLayerRenderer(scene.focusGuides, defaultRenderer);
    return renderer?.compose(defaultRenderer) ?? defaultRenderer;
  }
  function findGuideLayerRenderer(guides, defaultRenderer) {
    for (const guide of guides ?? []) {
      if (guide.renderer !== void 0 && guide.renderer !== defaultRenderer) {
        return requiredCompositor(guide.renderer);
      }
    }
    return void 0;
  }
  function findLayerRenderer(nodes, defaultRenderer) {
    for (const node of nodes) {
      if (node.renderer !== void 0 && node.renderer !== defaultRenderer) {
        return requiredCompositor(node.renderer);
      }
      if (node.kind === "group") {
        const renderer = findLayerRenderer(node.children, defaultRenderer);
        if (renderer) return renderer;
      }
    }
    return void 0;
  }
  function requiredCompositor(renderer) {
    const candidate = renderer;
    if (typeof candidate.compose !== "function") {
      throw new TypeError(
        `Mark renderer "${renderer.id}" cannot compose chart layers`
      );
    }
    return renderer;
  }
  function mountChartRenderer(container, initialOptions, runtime = createChartRuntime()) {
    resolveTooltipInput(initialOptions.definition.tooltip);
    let options = initialOptions;
    let scene;
    let interactionScene;
    let focusedPoint = null;
    let focusSource = "pointer";
    let focusOwner = null;
    let pointerPosition = null;
    let pinnedKey = null;
    let observer;
    let renderFrame;
    let forceScheduledRender = false;
    let scheduledRenderReason;
    let destroyed = false;
    let hasRendered = false;
    let surface;
    let unsubscribePresentation;
    let renderingSurface = false;
    let paintingFocus = false;
    let tooltipExtension;
    let tooltipInstance;
    let suppressNextSurfaceFocus = false;
    let spatialIndex;
    const controlInstances = /* @__PURE__ */ new Map();
    let cursorSession;
    let cursorMode;
    let cursorMatch;
    let cursorExtension;
    let renderedCursorBinding;
    let unsubscribeCursor;
    let cursorPresentation = null;
    let hasCursorPresentation = false;
    const previousPosition = container.style.position;
    const view = container.ownerDocument.defaultView;
    const computedPosition = view?.getComputedStyle(container).position;
    const ownsPosition = !computedPosition || computedPosition === "static";
    const domText = createDomTextMeasurer(container);
    const fontSet = container.ownerDocument.fonts;
    if (ownsPosition) container.style.position = "relative";
    const render = (refreshText = false, reason = "update") => {
      if (destroyed) return;
      if (refreshText && !options.measureText) domText.refresh();
      const previousFocusedPoint = focusedPoint;
      const previousCursorPresentation = cursorPresentation;
      const previousCursorBinding = renderedCursorBinding;
      scene = createHostedScene(createScene());
      interactionScene = scene;
      const renderer = resolveChartRenderer(scene, options.renderer);
      if (!surface) {
        surface = renderer.mount(container, scheduleRender);
        subscribeToPresentation();
      } else if (surface.renderer !== renderer) {
        unsubscribePresentation?.();
        unsubscribePresentation = void 0;
        destroyTooltip();
        destroyHostControls();
        surface.destroy();
        container.replaceChildren();
        surface = renderer.mount(container, scheduleRender);
        subscribeToPresentation();
        hasRendered = false;
      }
      renderingSurface = true;
      try {
        surface.render(scene, {
          ariaLabel: options.ariaLabel,
          ariaDescription: options.ariaDescription,
          className: options.className,
          tabIndex: resolveChartHostTabIndex(
            options.definition,
            options.tabIndex
          ),
          idPrefix: options.idPrefix,
          animation: hasRendered ? resolveAnimation(options.definition.svgAnimation, container, reason) : void 0
        });
      } finally {
        renderingSurface = false;
      }
      syncHostControls();
      hasRendered = true;
      const presentedPoints = interactionPoints();
      spatialIndex = options.definition.focus === false ? void 0 : options.definition.spatialIndex?.(
        viewportInteractionPoints(scene, scene.points),
        { scene }
      );
      const nextCursorBinding = cursorBinding();
      renderedCursorBinding = nextCursorBinding;
      if (nextCursorBinding) {
        applyCursorState(true);
      } else if (previousCursorBinding) {
        cursorPresentation = null;
        focusedPoint = null;
        pinnedKey = null;
        pointerPosition = null;
        focusOwner = null;
        paintFocus(null, []);
        if (previousFocusedPoint) {
          options.onFocusChange?.(null);
          options.onFocusGroupChange?.([]);
        }
      } else {
        cursorPresentation = null;
        const trackedPointer = (focusOwner === "pointer" || focusOwner === "controlled" && focusSource === "pointer") && pinnedKey === null ? pointerPosition : null;
        const nextFocusedPoints = trackedPointer ? resolvePointerFocus(trackedPointer.x, trackedPointer.y, maxDistance()) : previousFocusedPoint ? (() => {
          const restored = restoreChartFocusPoint(
            presentedPoints,
            previousFocusedPoint
          );
          return restored ? focusPointsForPoint(restored, presentedPoints) : [];
        })() : [];
        const nextFocusedPoint = nextFocusedPoints[0] ?? null;
        focusedPoint = nextFocusedPoint;
        if (!nextFocusedPoint) pinnedKey = null;
        if (previousFocusedPoint || nextFocusedPoint || previousCursorPresentation) {
          if (!trackedPointer) focusSource = "restored";
          paintFocus(nextFocusedPoint, nextFocusedPoints);
          options.onFocusChange?.(nextFocusedPoint);
          options.onFocusGroupChange?.(nextFocusedPoints);
        }
      }
      const onRender = options.onRender;
      if (onRender) {
        onRender({ container, scene, surface, interaction });
      }
    };
    const currentWidth = () => {
      const width = options.width ?? container.getBoundingClientRect().width;
      return options.width !== void 0 || width > 0 ? width : void 0;
    };
    const configureObserver = () => {
      observer?.disconnect();
      observer = void 0;
      if (options.width !== void 0) return;
      const ResizeObserverConstructor = view?.ResizeObserver;
      if (!ResizeObserverConstructor) return;
      observer = new ResizeObserverConstructor(() => {
        const width = currentWidth();
        if (width === void 0 || width === scene.width) return;
        scheduleRender(false, "resize");
      });
      observer.observe(container);
    };
    const scheduleRender = (force = false, reason = "layout") => {
      forceScheduledRender ||= force;
      scheduledRenderReason = scheduledRenderReason === "layout" || reason === "layout" ? "layout" : "resize";
      if (renderFrame !== void 0) return;
      if (!view?.requestAnimationFrame) {
        const nextWidth = currentWidth();
        const shouldRender = forceScheduledRender || nextWidth !== void 0 && nextWidth !== scene.width;
        forceScheduledRender = false;
        const nextReason = scheduledRenderReason ?? "layout";
        scheduledRenderReason = void 0;
        if (shouldRender) render(true, nextReason);
        return;
      }
      renderFrame = view.requestAnimationFrame(() => {
        renderFrame = void 0;
        const nextWidth = currentWidth();
        const shouldRender = forceScheduledRender || nextWidth !== void 0 && nextWidth !== scene.width;
        forceScheduledRender = false;
        const nextReason = scheduledRenderReason ?? "layout";
        scheduledRenderReason = void 0;
        if (shouldRender) render(true, nextReason);
      });
    };
    const handleFontLoad = () => {
      if (destroyed || options.measureText) return;
      domText.invalidate();
      scheduleRender(true);
    };
    const cursorBinding = () => options.definition.cursor;
    const cursorIsPinned = () => cursorSession?.getState()?.pinned === true;
    const interactionIsPinned = () => pinnedKey !== null || cursorIsPinned();
    const configureCursorController = () => {
      const nextBinding = cursorBinding();
      if (nextBinding) hasCursorPresentation = true;
      const nextController = nextBinding?.controller;
      const nextMode = nextBinding?.mode;
      const nextMatch = nextBinding?.mode === "focus" ? nextBinding.match ?? "xy" : void 0;
      if (nextController === cursorSession?.controller && nextMode === cursorMode && nextMatch === cursorMatch && nextBinding?.use === cursorExtension) {
        return;
      }
      unsubscribeCursor?.();
      unsubscribeCursor = void 0;
      cursorSession?.destroy();
      cursorSession = nextBinding ? createChartCursorHostSession(nextBinding) : void 0;
      cursorMode = nextMode;
      cursorMatch = nextMatch;
      cursorExtension = nextBinding?.use;
      unsubscribeCursor = cursorSession?.subscribe(() => {
        if (!destroyed && hasRendered) applyCursorState(false);
      });
    };
    const applyCursorState = (notifyRestored) => {
      const binding = cursorBinding();
      if (!binding) {
        cursorPresentation = null;
        return;
      }
      const session = cursorSession;
      if (!session) return;
      const state = session.getState();
      if (state?.source !== "pointer" || !session.owns(state)) {
        pointerPosition = null;
      }
      cursorPresentation = session.resolvePresentation(scene, binding, state);
      const previous = focusedPoint;
      if (binding.mode === "focus") {
        const focus = resolveChartFocusStrategy(options.definition.focus);
        const points = session.resolveFocus(
          interactionPoints(),
          binding,
          state,
          focus
        );
        const point3 = points[0] ?? null;
        if (state) focusSource = state.source;
        pinnedKey = state?.pinned && point3 ? point3.key : null;
        focusedPoint = point3;
        paintFocus(point3, points);
        if (!sameChartPointIdentity(previous, point3) || notifyRestored && (previous !== null || point3 !== null)) {
          options.onFocusChange?.(point3);
          options.onFocusGroupChange?.(points);
        }
        return;
      }
      pinnedKey = null;
      focusedPoint = null;
      paintFocus(null, []);
      if (previous) {
        options.onFocusChange?.(null);
        options.onFocusGroupChange?.([]);
      }
    };
    const publishFocusCursor = (points, pinned = interactionIsPinned()) => {
      const binding = cursorBinding();
      if (binding?.mode !== "focus") return false;
      const session = cursorSession;
      if (!session) return false;
      const point3 = points[0];
      if (!point3) {
        session.clearOwnedTransient();
        return true;
      }
      session.publish(
        session.createFocusState(scene, binding, {
          primary: point3,
          group: points,
          source: focusSource,
          pinned
        })
      );
      return true;
    };
    const updateFocus = (points, forcePaint = false) => {
      const point3 = points[0] ?? null;
      if (publishFocusCursor(points)) return;
      if (sameChartPointIdentity(point3, focusedPoint)) {
        focusedPoint = point3;
        if (forcePaint) paintFocus(point3, points);
        return;
      }
      focusedPoint = point3;
      paintFocus(point3, points);
      options.onFocusChange?.(point3);
      options.onFocusGroupChange?.(points);
    };
    const dismissTooltip = () => {
      const binding = cursorBinding();
      if (!focusedPoint && !pinnedKey && !cursorSession?.getState()) return;
      const restoreFocus = Boolean(
        tooltipInstance?.contains(container.ownerDocument.activeElement)
      );
      pinnedKey = null;
      pointerPosition = null;
      focusOwner = null;
      if (binding) cursorSession?.clear();
      else updateFocus([]);
      const element = surface?.element;
      if (restoreFocus && element && "focus" in element && typeof element.focus === "function") {
        suppressNextSurfaceFocus = true;
        element.focus();
      }
    };
    const paintFocus = (point3, points) => {
      paintingFocus = true;
      let paintedScene;
      try {
        const focus = point3 ? {
          primary: point3,
          group: points,
          source: focusSource,
          pinned: interactionIsPinned()
        } : null;
        paintedScene = hasCursorPresentation ? surface?.paintFocus(focus, pointerPosition, cursorPresentation) : surface?.paintFocus(focus, pointerPosition);
      } finally {
        paintingFocus = false;
      }
      interactionScene = paintedScene ?? scene;
      paintTooltip(point3, points);
    };
    const resolveClientPointer = (clientX, clientY) => {
      const position = surface?.clientToScene?.(scene, clientX, clientY);
      if (!position) return null;
      return {
        position,
        points: resolvePointerFocus(position.x, position.y, maxDistance())
      };
    };
    const pointsAtPointer = (clientX, clientY) => {
      const resolved = resolveClientPointer(clientX, clientY);
      pointerPosition = resolved?.position ?? null;
      return resolved?.points ?? [];
    };
    const interaction = {
      clientToScene(clientX, clientY) {
        if (destroyed) return null;
        return surface?.clientToScene?.(scene, clientX, clientY) ?? null;
      },
      resolvePointer(clientX, clientY) {
        if (destroyed) return null;
        const resolved = resolveClientPointer(clientX, clientY);
        const point3 = resolved?.points[0];
        return resolved && point3 ? {
          position: resolved.position,
          point: point3,
          points: resolved.points
        } : null;
      },
      setControlledFocus(target, controlledOptions = {}) {
        if (destroyed) return;
        focusOwner = "controlled";
        if (!target) {
          focusSource = controlledOptions.source ?? "programmatic";
          pointerPosition = null;
          pinnedKey = null;
          updateFocus([]);
          focusOwner = null;
          return;
        }
        let resolution;
        let targetPoint;
        if (isPointerResolution(target)) {
          resolution = target;
          targetPoint = target.point;
        } else {
          resolution = null;
          targetPoint = target;
        }
        focusSource = controlledOptions.source ?? (resolution === null ? "programmatic" : "pointer");
        const points = interactionPoints();
        const point3 = restoreChartFocusPoint(points, targetPoint);
        pointerPosition = resolution?.position ?? null;
        if (!point3) {
          pinnedKey = null;
          updateFocus([]);
          focusOwner = null;
          return;
        }
        const focusPoints = focusPointsForPoint(point3, points);
        pinnedKey = controlledOptions.pinned && (tooltipIsSticky() || cursorBinding()?.pin === true) ? point3.key : null;
        if (sameChartPointIdentity(point3, focusedPoint)) {
          focusedPoint = point3;
          paintFocus(point3, focusPoints);
          return;
        }
        updateFocus(focusPoints);
      }
    };
    const scenePositionAtPointer = (clientX, clientY) => {
      const position = surface?.clientToScene?.(scene, clientX, clientY);
      pointerPosition = position ?? null;
      return position;
    };
    const updateFreeCursorAtPointer = (clientX, clientY) => {
      const binding = cursorBinding();
      if (binding?.mode !== "free") return false;
      if (cursorIsPinned()) return true;
      const position = scenePositionAtPointer(clientX, clientY);
      if (!position || !plotContains(scene, position)) {
        pointerPosition = null;
        cursorSession?.clearOwnedTransient();
        return true;
      }
      const session = cursorSession;
      if (!session) return false;
      session.publish(
        session.createFreeState(scene, binding, position, "pointer", false)
      );
      return true;
    };
    const handlePointerMove = (event) => {
      if (controlContains(event.target)) {
        if (!interactionIsPinned()) {
          pointerPosition = null;
          updateFocus([]);
        }
        return;
      }
      if (options.definition.pointer === false || interactionIsPinned()) return;
      focusOwner = "pointer";
      focusSource = "pointer";
      if (updateFreeCursorAtPointer(event.clientX, event.clientY)) return;
      updateFocus(
        pointsAtPointer(event.clientX, event.clientY),
        tooltipTracksPointer()
      );
    };
    const handlePointerDown = (event) => {
      if (options.definition.pointer === false || interactionIsPinned()) return;
      focusOwner = "pointer";
      focusSource = "pointer";
      updateFreeCursorAtPointer(event.clientX, event.clientY);
    };
    const clearPointerFocus = ({ relatedTarget }) => {
      if (options.definition.pointer !== false && focusOwner === "pointer" && !interactionIsPinned() && !(view && relatedTarget instanceof view.Node && container.contains(relatedTarget))) {
        pointerPosition = null;
        const binding = cursorBinding();
        if (binding) cursorSession?.clearOwnedTransient();
        else updateFocus([]);
        focusOwner = null;
      }
    };
    const clearKeyboardFocus = ({ relatedTarget }) => {
      if (focusOwner === "keyboard" && !pinnedKey && !(view && relatedTarget instanceof view.Node && container.contains(relatedTarget))) {
        pointerPosition = null;
        const binding = cursorBinding();
        if (binding) cursorSession?.clearOwnedTransient();
        else updateFocus([]);
        focusOwner = null;
      }
    };
    const dismissPinnedInteractionOutside = (event) => {
      if (options.definition.pointer === false || pinnedKey === null || cursorIsPinned()) {
        return;
      }
      const path2 = event.composedPath();
      if (path2.includes(container) || path2.some(
        (target) => view && target instanceof view.Node && tooltipInstance?.contains(target)
      )) {
        return;
      }
      dismissTooltip();
    };
    const handleClick = (event) => {
      if (controlContains(event.target)) return;
      if (options.definition.pointer === false) return;
      const activeTooltip = tooltipInstance;
      const NodeConstructor = container.ownerDocument.defaultView?.Node;
      const originatedInTooltip = NodeConstructor ? event.composedPath().some(
        (target) => target instanceof NodeConstructor && activeTooltip?.contains(target)
      ) : activeTooltip?.contains(event.target);
      if (activeTooltip && originatedInTooltip) {
        return;
      }
      focusOwner = "pointer";
      const binding = cursorBinding();
      if (binding?.mode === "free") {
        const state = cursorSession?.getState();
        if (!state) {
          updateFreeCursorAtPointer(event.clientX, event.clientY);
        }
        const current = cursorSession?.getState();
        if (binding.pin && current) {
          if (current.pinned) {
            cursorSession?.clear();
          } else {
            cursorSession?.publish({ ...current, pinned: true });
          }
        }
        options.onSelect?.(null);
        return;
      }
      const points = pointsAtPointer(event.clientX, event.clientY);
      focusSource = "pointer";
      const point3 = points[0] ?? null;
      let pinChanged = false;
      const canPin = tooltipIsSticky() || binding?.pin === true;
      if (canPin) {
        if (interactionIsPinned()) {
          pinnedKey = null;
          pinChanged = true;
          if (binding) cursorSession?.clear();
        } else if (point3) {
          pinnedKey = point3.key;
          pinChanged = true;
        }
      }
      if (!(binding && canPin && pinChanged && !pinnedKey)) {
        updateFocus(points, pinChanged);
      }
      options.definition.selection?.change(point3, "pointer");
      options.onSelect?.(point3);
    };
    const handleKeyDown = (event) => {
      if (controlContains(event.target)) return;
      const binding = cursorBinding();
      if (event.key === "Escape" && cursorSession?.getState()) {
        event.preventDefault();
        dismissTooltip();
        return;
      }
      if (event.key === "Escape" && pinnedKey) {
        event.preventDefault();
        dismissTooltip();
        return;
      }
      if (options.definition.keyboard === false || binding?.mode === "free") {
        return;
      }
      const points = interactionPoints();
      if (!points.length) return;
      if (event.key === "Enter" || event.key === " ") {
        if (!focusedPoint) return;
        event.preventDefault();
        const point22 = focusedPoint;
        const canPin = tooltipIsSticky() || binding?.pin === true;
        if (binding?.mode === "focus" && canPin) {
          if (interactionIsPinned()) {
            pinnedKey = null;
            cursorSession?.clear();
          } else {
            pinnedKey = point22.key;
            publishFocusCursor(focusPointsForPoint(point22), true);
          }
        } else if (tooltipIsSticky()) {
          pinnedKey = pinnedKey ? null : point22.key;
          paintFocus(point22, focusPointsForPoint(point22));
        }
        options.definition.selection?.change(point22, "keyboard");
        options.onSelect?.(point22);
        return;
      }
      const focus = resolveRendererFocusStrategy(options.definition.focus);
      const point3 = focus ? chartPointFromNavigationOrder(
        focus.navigation(points),
        focusedPoint,
        event.key
      ) : chartPointFromSceneOrder(points, focusedPoint, event.key);
      if (point3 === void 0) return;
      event.preventDefault();
      pointerPosition = null;
      focusOwner = "keyboard";
      focusSource = "keyboard";
      updateFocus(point3 ? focusPointsForPoint(point3) : []);
    };
    const handleFocus = (event) => {
      if (controlContains(event.target)) {
        if (!pinnedKey) {
          pointerPosition = null;
          updateFocus([]);
        }
        return;
      }
      if (event.target === surface?.element && suppressNextSurfaceFocus) {
        suppressNextSurfaceFocus = false;
        return;
      }
      if (options.definition.keyboard !== false && cursorBinding()?.mode !== "free" && event.target === surface?.element && !focusedPoint) {
        const focus = resolveRendererFocusStrategy(options.definition.focus);
        const points = interactionPoints();
        const point3 = focus ? focus.navigation(points)[0] : chartPointFromSceneOrder(points, null, "Home");
        pointerPosition = null;
        focusOwner = "keyboard";
        focusSource = "keyboard";
        updateFocus(point3 ? focusPointsForPoint(point3) : []);
      }
    };
    container.addEventListener("pointermove", handlePointerMove);
    container.addEventListener("pointerdown", handlePointerDown);
    container.addEventListener("pointercancel", clearPointerFocus);
    container.addEventListener("mouseleave", clearPointerFocus);
    container.addEventListener("click", handleClick);
    container.addEventListener("keydown", handleKeyDown);
    container.addEventListener("focusin", handleFocus);
    container.addEventListener("focusout", clearKeyboardFocus);
    fontSet?.addEventListener?.("loadingdone", handleFontLoad);
    configureCursorController();
    render();
    configureObserver();
    container.ownerDocument.addEventListener(
      "pointerdown",
      dismissPinnedInteractionOutside,
      true
    );
    return {
      interaction,
      update(nextOptions) {
        if (destroyed) return;
        resolveTooltipInput(nextOptions.definition.tooltip);
        const fontChanged = nextOptions.measureText === void 0 && domText.refresh();
        const definitionChanged = options.definition !== nextOptions.definition;
        const sizeChanged = options.height !== nextOptions.height || options.aspectRatio !== nextOptions.aspectRatio || options.width !== nextOptions.width || options.initialWidth !== nextOptions.initialWidth;
        const layoutChanged = options.idPrefix !== nextOptions.idPrefix || options.renderer !== nextOptions.renderer || options.measureText !== nextOptions.measureText || fontChanged;
        const needsRender = definitionChanged || sizeChanged || options.ariaLabel !== nextOptions.ariaLabel || options.ariaDescription !== nextOptions.ariaDescription || options.className !== nextOptions.className || options.tabIndex !== nextOptions.tabIndex || options.idPrefix !== nextOptions.idPrefix || options.renderer !== nextOptions.renderer || options.measureText !== nextOptions.measureText || fontChanged;
        const observerChanged = options.width !== nextOptions.width;
        const pointerDisabled = options.definition.pointer !== false && nextOptions.definition.pointer === false && focusOwner === "pointer";
        options = nextOptions;
        configureCursorController();
        syncTooltip();
        if (pointerDisabled) {
          pointerPosition = null;
          pinnedKey = null;
          focusOwner = null;
          updateFocus([]);
        }
        if (!tooltipIsSticky()) pinnedKey = null;
        if (needsRender) {
          render(
            false,
            layoutChanged ? "layout" : sizeChanged ? "resize" : "update"
          );
        } else {
          if (cursorBinding()) {
            applyCursorState(false);
          } else if (focusedPoint) {
            paintFocus(focusedPoint, focusPointsForPoint(focusedPoint));
          }
        }
        if (observerChanged) configureObserver();
      },
      getScene: () => scene,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        observer?.disconnect();
        unsubscribeCursor?.();
        unsubscribeCursor = void 0;
        cursorSession?.destroy();
        cursorSession = void 0;
        cursorMode = void 0;
        cursorMatch = void 0;
        cursorExtension = void 0;
        fontSet?.removeEventListener?.("loadingdone", handleFontLoad);
        if (renderFrame !== void 0) {
          view?.cancelAnimationFrame?.(renderFrame);
        }
        destroyTooltip();
        destroyHostControls();
        unsubscribePresentation?.();
        unsubscribePresentation = void 0;
        surface?.destroy();
        runtime.destroy();
        container.removeEventListener("pointermove", handlePointerMove);
        container.removeEventListener("pointerdown", handlePointerDown);
        container.removeEventListener("pointercancel", clearPointerFocus);
        container.removeEventListener("mouseleave", clearPointerFocus);
        container.removeEventListener("click", handleClick);
        container.removeEventListener("keydown", handleKeyDown);
        container.removeEventListener("focusin", handleFocus);
        container.removeEventListener("focusout", clearKeyboardFocus);
        container.ownerDocument.removeEventListener(
          "pointerdown",
          dismissPinnedInteractionOutside,
          true
        );
        container.replaceChildren();
        if (ownsPosition && container.style.position === "relative") {
          container.style.position = previousPosition;
        }
      }
    };
    function createScene() {
      const width = currentWidth() ?? options.initialWidth ?? 640;
      return runtime.render(
        options.definition,
        {
          width,
          height: options.height ?? (isPositiveFiniteNumber(options.aspectRatio) ? width / options.aspectRatio : 320)
        },
        {
          measureText: options.measureText ?? domText.measureText,
          typography: domText.typography()
        }
      );
    }
    function syncHostControls() {
      const retained = /* @__PURE__ */ new Set();
      for (const control of scene.controls ?? []) {
        const extension = control.extension;
        const identity = `${extension.id}:${control.key}`;
        retained.add(identity);
        let current = controlInstances.get(identity);
        if (current && current.extension !== extension) {
          current.instance.destroy();
          controlInstances.delete(identity);
          current = void 0;
        }
        if (!current) {
          current = {
            extension,
            instance: extension.create({ container, surface })
          };
          controlInstances.set(identity, current);
        }
        current.instance.update(control, scene);
      }
      for (const [identity, current] of controlInstances) {
        if (retained.has(identity)) continue;
        current.instance.destroy();
        controlInstances.delete(identity);
      }
    }
    function destroyHostControls() {
      for (const current of controlInstances.values()) {
        current.instance.destroy();
      }
      controlInstances.clear();
    }
    function controlContains(target) {
      for (const current of controlInstances.values()) {
        if (current.instance.contains?.(target)) return true;
      }
      return false;
    }
    function resolvePointerFocus(x2, y2, maxDistance2) {
      const points = interactionPoints();
      const focus = resolveRendererFocusStrategy(options.definition.focus);
      const focused = resolveChartPointerFocus(
        interactionScene,
        focus,
        x2,
        y2,
        maxDistance2,
        points
      );
      if (focused) return focused;
      const presentationPoints = surface?.getPresentationPoints?.();
      const candidate = presentationPoints !== void 0 ? nearestPoint(points, x2, y2, maxDistance2) : spatialIndex && interactionScene === scene ? spatialIndex.findNearest(x2, y2, maxDistance2) : findNearestPoint(interactionScene, x2, y2, maxDistance2, points);
      const point3 = candidate ? restoreChartFocusPoint(points, candidate) : null;
      return point3 ? [point3] : [];
    }
    function interactionPoints() {
      const points = surface?.getPresentationPoints?.() ?? interactionScene.points;
      return viewportInteractionPoints(scene, points);
    }
    function focusPointsForPoint(point3, points = interactionPoints()) {
      return resolveRendererFocusStrategy(options.definition.focus)?.group(points, {
        point: point3
      }) ?? [point3];
    }
    function subscribeToPresentation() {
      unsubscribePresentation = surface?.subscribePresentationPoints?.(
        handlePresentationPoints
      );
    }
    function handlePresentationPoints(points) {
      if (destroyed || renderingSurface || paintingFocus) return;
      if (cursorBinding()) {
        applyCursorState(false);
        return;
      }
      const visiblePoints = viewportInteractionPoints(scene, points);
      if (pointerPosition && pinnedKey === null) {
        updateFocus(
          resolvePointerFocus(
            pointerPosition.x,
            pointerPosition.y,
            maxDistance()
          ),
          true
        );
        return;
      }
      if (!focusedPoint) return;
      const point3 = restoreChartFocusPoint(visiblePoints, focusedPoint);
      updateFocus(point3 ? focusPointsForPoint(point3, visiblePoints) : [], true);
    }
    function maxDistance() {
      return options.definition.maxFocusDistance ?? 48;
    }
    function paintTooltip(point3, points) {
      const input = resolveTooltipInput(options.definition.tooltip);
      if (!input || !point3 || !surface) {
        tooltipInstance?.hide();
        return;
      }
      if (tooltipExtension !== input.extension || !tooltipInstance) {
        destroyTooltip();
        tooltipExtension = input.extension;
        const tooltipMotionCapability = surface.renderer.capabilities?.tooltipMotion;
        tooltipInstance = input.extension.create({
          container,
          motion: tooltipMotionCapability?.protocol === 1 ? tooltipMotionCapability.createController({
            container,
            transition: resolveTooltipMotion
          }) : void 0,
          dismiss: dismissTooltip,
          bodyChange: () => options.onTooltipBodyChange
        });
      }
      const instance = tooltipInstance;
      instance.update(input.options);
      instance.paint({
        point: point3,
        points,
        scene,
        surface,
        pointer: pointerPosition,
        focus: {
          primary: point3,
          group: points,
          source: focusSource,
          pinned: interactionIsPinned()
        },
        pinned: interactionIsPinned()
      });
    }
    function resolveTooltipMotion() {
      const definition2 = options.definition.motion;
      if (definition2 === false) return false;
      return typeof definition2 === "function" ? void 0 : definition2?.transition;
    }
    function syncTooltip() {
      const input = resolveTooltipInput(options.definition.tooltip);
      if (!input) {
        tooltipInstance?.update(emptyTooltipOptions);
        tooltipInstance?.hide();
      } else if (input.extension !== tooltipExtension) {
        destroyTooltip();
      } else {
        tooltipInstance?.update(input.options);
      }
    }
    function destroyTooltip() {
      tooltipInstance?.destroy();
      tooltipInstance = void 0;
      tooltipExtension = void 0;
    }
    function tooltipIsSticky() {
      const input = resolveTooltipInput(options.definition.tooltip);
      return Boolean(input && input.options.sticky !== false);
    }
    function tooltipTracksPointer() {
      const input = resolveTooltipInput(options.definition.tooltip);
      const anchor = input?.options.anchor;
      return anchor === "pointer" || typeof anchor === "function" || typeof anchor === "object" && (anchor.x === "pointer" || anchor.y === "pointer");
    }
  }
  var emptyTooltipOptions = {};
  function createHostedScene(scene) {
    const fallbackKeys = new Set(
      (scene.controls ?? []).flatMap(
        (control) => control.fallbackNodeKey ? [control.fallbackNodeKey] : []
      )
    );
    if (!fallbackKeys.size) return scene;
    return {
      ...scene,
      nodes: scene.nodes.filter((node) => !fallbackKeys.has(node.key))
    };
  }
  function isPointerResolution(target) {
    return "position" in target && "point" in target && "points" in target;
  }
  function resolveTooltipInput(input) {
    if (!input) return null;
    const extension = "create" in input ? input : input.use;
    if (extension.__chartTooltipHost !== "dom") {
      throw new TypeError(
        "DOM chart hosts require a tooltip extension from @tanstack/charts/tooltip."
      );
    }
    const domExtension = extension;
    return "create" in input ? {
      extension: domExtension,
      options: emptyTooltipOptions
    } : {
      extension: domExtension,
      options: input
    };
  }
  function isPositiveFiniteNumber(value2) {
    return typeof value2 === "number" && Number.isFinite(value2) && value2 > 0;
  }
  function resolveRendererFocusStrategy(focus) {
    if (focus === false) return focusDisabled;
    return resolveChartFocusStrategy(focus);
  }
  function plotContains(scene, position) {
    return position.x >= scene.chart.x && position.x <= scene.chart.x + scene.chart.width && position.y >= scene.chart.y && position.y <= scene.chart.y + scene.chart.height;
  }
  function resolveAnimation(animation, container, reason) {
    const configured = animation === true ? {} : animation || void 0;
    if (!configured) return void 0;
    if (reason === "layout") return void 0;
    if (reason === "resize" && configured.resize !== true) return void 0;
    if ((configured.respectReducedMotion ?? true) && container.ownerDocument.defaultView?.matchMedia?.(
      "(prefers-reduced-motion: reduce)"
    ).matches) {
      return void 0;
    }
    const { resize: _resize, ...resolved } = configured;
    return resolved;
  }

  // node_modules/@tanstack/charts/dist/reconcile.js
  var interpolatedAttributes = /* @__PURE__ */ new Set([
    "cx",
    "cy",
    "d",
    "fill-opacity",
    "font-size",
    "font-weight",
    "height",
    "opacity",
    "r",
    "rx",
    "stroke-opacity",
    "stroke-width",
    "transform",
    "width",
    "x",
    "x1",
    "x2",
    "y",
    "y1",
    "y2"
  ]);
  function reconcileChartSvg(container, markup, animation) {
    const template = container.ownerDocument.createElement("template");
    template.innerHTML = markup;
    const nextRoot = template.content.firstElementChild;
    if (!nextRoot) return () => {
    };
    const currentRoot = container.firstElementChild;
    if (!currentRoot || currentRoot.namespaceURI !== nextRoot.namespaceURI || currentRoot.localName !== nextRoot.localName) {
      container.replaceChildren(nextRoot);
      return () => {
      };
    }
    const tweens = [];
    reconcileElement(currentRoot, nextRoot, animation ? tweens : void 0);
    return animation ? runTweens(container, tweens, animation) : () => {
    };
  }
  function reconcileChartSvgFragment(currentRoot, markup, animation) {
    const template = currentRoot.ownerDocument.createElement("template");
    template.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`;
    const wrapper = template.content.firstElementChild;
    const nextRoot = wrapper?.firstElementChild;
    if (!nextRoot) return () => {
    };
    if (currentRoot.namespaceURI !== nextRoot.namespaceURI || currentRoot.localName !== nextRoot.localName) {
      currentRoot.replaceWith(nextRoot);
      return () => {
      };
    }
    const tweens = [];
    reconcileElement(currentRoot, nextRoot, animation ? tweens : void 0);
    return animation ? runTweens(currentRoot, tweens, animation) : () => {
    };
  }
  function reconcileElement(current, next, tweens) {
    syncAttributes(current, next, tweens);
    if (!next.firstElementChild) {
      if (current.firstElementChild) {
        for (const child of [...current.children]) {
          if (tweens) addExitTween(child, tweens);
          else child.remove();
        }
      } else if (current.textContent !== next.textContent) {
        current.textContent = next.textContent;
      }
      return;
    }
    const currentChildren = [...current.children];
    const nextChildren = [...next.children];
    const currentByIdentity = indexChildren(currentChildren);
    const nextIdentities = identities(nextChildren);
    const retained = /* @__PURE__ */ new Set();
    let cursor = current.firstElementChild;
    nextChildren.forEach((nextChild, index) => {
      const identity = nextIdentities[index];
      const matched = currentByIdentity.get(identity);
      let rendered;
      if (matched && matched.namespaceURI === nextChild.namespaceURI && matched.localName === nextChild.localName) {
        rendered = matched;
        retained.add(matched);
        if (rendered !== cursor) current.insertBefore(rendered, cursor);
        reconcileElement(rendered, nextChild, tweens);
      } else {
        rendered = nextChild.cloneNode(true);
        current.insertBefore(rendered, cursor);
        addEnterTween(rendered, nextChild, tweens);
      }
      cursor = rendered.nextElementSibling;
    });
    for (const child of currentChildren) {
      if (!retained.has(child) && child.parentElement === current) {
        if (tweens) addExitTween(child, tweens);
        else child.remove();
      }
    }
  }
  function syncAttributes(current, next, tweens) {
    const nextNames = new Set(next.getAttributeNames());
    for (const name of current.getAttributeNames()) {
      if (!nextNames.has(name)) current.removeAttribute(name);
    }
    for (const name of nextNames) {
      const target = next.getAttribute(name);
      const previous = current.getAttribute(name);
      if (target === previous) continue;
      const interpolate2 = tweens && previous !== null && target !== null && interpolatedAttributes.has(name) ? interpolateAttribute(name, previous, target) : void 0;
      if (interpolate2 && tweens) {
        tweens.push({ element: current, name, interpolate: interpolate2, target });
      } else if (target !== null) {
        current.setAttribute(name, target);
      }
    }
  }
  function addEnterTween(current, next, tweens) {
    if (!tweens) return;
    const target = next.getAttribute("opacity");
    const targetValue = target ?? "1";
    current.setAttribute("opacity", "0");
    tweens.push({
      element: current,
      name: "opacity",
      interpolate: (progress) => String(Number(targetValue) * Math.max(0, Math.min(1, progress))),
      target
    });
  }
  function addExitTween(current, tweens) {
    const opacity = Number(current.getAttribute("opacity") ?? 1);
    const start = Number.isFinite(opacity) ? opacity : 1;
    tweens.push({
      element: current,
      name: "opacity",
      interpolate: (progress) => String(start * (1 - progress)),
      target: "0",
      removeOnFinish: true
    });
  }
  function runTweens(container, tweens, options) {
    if (!tweens.length) return () => {
    };
    const view = container.ownerDocument.defaultView;
    const requestFrame = view?.requestAnimationFrame?.bind(view);
    const cancelFrame = view?.cancelAnimationFrame?.bind(view);
    const duration = Math.max(0, options.duration ?? 240);
    if (!requestFrame || !cancelFrame || duration === 0) {
      finishTweens(tweens);
      return () => {
      };
    }
    let frame = 0;
    let cancelled = false;
    let start;
    const ease = easing(options.easing ?? "ease-out");
    const tick2 = (time) => {
      if (cancelled) return;
      start ??= time;
      const progress = Math.min(1, (time - start) / duration);
      const eased = ease(progress);
      for (const tween of tweens) {
        tween.element.setAttribute(tween.name, tween.interpolate(eased));
      }
      if (progress < 1) frame = requestFrame(tick2);
      else finishTweens(tweens);
    };
    frame = requestFrame(tick2);
    return () => {
      cancelled = true;
      cancelFrame(frame);
    };
  }
  function finishTweens(tweens) {
    for (const tween of tweens) {
      if (tween.removeOnFinish) {
        tween.element.remove();
        continue;
      }
      if (tween.target === null) tween.element.removeAttribute(tween.name);
      else tween.element.setAttribute(tween.name, tween.target);
    }
  }
  function interpolateAttribute(name, previous, next) {
    const path2 = name === "d";
    const previousNumbers = extractNumbers(previous, path2);
    const nextNumbers = extractNumbers(next, path2);
    if (previousNumbers.skeleton !== nextNumbers.skeleton || previousNumbers.values.length !== nextNumbers.values.length || !previousNumbers.values.length) {
      return void 0;
    }
    const template = nextNumbers.skeleton;
    return (progress) => {
      let index = 0;
      return template.replaceAll(/[#!]/g, (placeholder) => {
        const start = previousNumbers.values[index];
        const end = nextNumbers.values[index];
        index += 1;
        return formatNumber(
          placeholder === "!" ? end : start + (end - start) * progress
        );
      });
    };
  }
  function extractNumbers(value2, path2 = false) {
    const values = [];
    let skeleton = "";
    let command = "";
    let argument = 0;
    let index = 0;
    while (index < value2.length) {
      const rest = value2.slice(index);
      const arcPosition = argument % 7;
      const arcFlag = path2 && /a/i.test(command) && arcPosition > 2 && arcPosition < 5;
      const match = arcFlag ? /^[01]/u.exec(rest) : /^-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/iu.exec(rest);
      if (match) {
        values.push(Number(match[0]));
        skeleton += arcFlag ? "!" : "#";
        argument += 1;
        index += match[0].length;
        continue;
      }
      const character = value2[index];
      skeleton += character;
      if (path2 && /[a-z]/i.test(character)) {
        command = character;
        argument = 0;
      }
      index += 1;
    }
    return { skeleton, values };
  }
  function indexChildren(children) {
    const result = /* @__PURE__ */ new Map();
    identities(children).forEach((identity, index) => {
      result.set(identity, children[index]);
    });
    return result;
  }
  function identities(children) {
    const counts = /* @__PURE__ */ new Map();
    return children.map((child) => {
      const explicit = child.getAttribute("data-ts-key");
      if (explicit) return `key:${explicit}`;
      const count2 = counts.get(child.localName) ?? 0;
      counts.set(child.localName, count2 + 1);
      return `tag:${child.localName}:${count2}`;
    });
  }
  function easing(name) {
    if (typeof name === "function") return name;
    switch (name) {
      case "linear":
        return (value2) => value2;
      case "ease-in":
        return (value2) => value2 * value2;
      case "ease-in-out":
        return (value2) => value2 < 0.5 ? 2 * value2 * value2 : 1 - Math.pow(-2 * value2 + 2, 2) / 2;
      case "ease":
      case "ease-out":
        return (value2) => 1 - Math.pow(1 - value2, 3);
    }
  }
  function formatNumber(value2) {
    return String(Math.round(value2 * 1e3) / 1e3);
  }

  // node_modules/@tanstack/charts/dist/svg-renderer.js
  function renderChartSvgWithHooks(scene, options, hooks) {
    const idPrefix = options.idPrefix ?? "";
    const className = options.className ? `ts-chart ${options.className}` : "ts-chart";
    const description = options.ariaDescription ? `<desc>${escapeText(options.ariaDescription)}</desc>` : "";
    const definitions = hooks?.renderDefinitions?.(scene, idPrefix) ?? "";
    const background = scene.theme.background === "transparent" ? "" : renderNode(
      {
        kind: "rect",
        key: "background",
        x: 0,
        y: 0,
        width: scene.width,
        height: scene.height,
        style: { fill: scene.theme.background }
      },
      hooks,
      idPrefix
    );
    return `<svg class="${escapeAttribute(className)}" width="100%" height="100%" viewBox="0 0 ${number(scene.width)} ${number(scene.height)}" role="img" aria-roledescription="chart" aria-label="${escapeAttribute(options.ariaLabel)}" tabindex="${number(options.tabIndex ?? 0)}" style="display:block;overflow:visible">${description}${definitions}${background}${renderSceneNodes(scene.nodes, idPrefix, hooks)}</svg>`;
  }
  function renderSceneNodes(nodes, idPrefix = "", hooks) {
    return nodes.map((node) => renderNode(node, hooks, idPrefix)).join("");
  }
  function renderFocusGuideLayer(nodes, placement, idPrefix = "", hooks) {
    const visibility = nodes.length ? "visible" : "hidden";
    return `<g data-ts-key="focus-guide-layer:${placement}" class="ts-chart__focus-guide-layer ts-chart__focus-guide-layer--${placement}" data-ts-focus-layer="${placement}" data-ts-focus-guide-layer="${placement}" aria-hidden="true" visibility="${visibility}">${renderSceneNodes(nodes, idPrefix, hooks ?? focusGuideRenderHooks)}</g>`;
  }
  var focusGuideRenderHooks = {
    renderGroup: renderFocusGuideClip
  };
  function renderNode(node, hooks, idPrefix) {
    const common = renderCommon(node, hooks, idPrefix);
    switch (node.kind) {
      case "group": {
        const transform = node.translateX === void 0 && node.translateY === void 0 ? "" : ` transform="translate(${number(node.translateX ?? 0)} ${number(node.translateY ?? 0)})"`;
        const extension = hooks?.renderGroup?.(node, idPrefix);
        const focus = node.focus ? ` data-ts-focus-layer="${node.focus.placement}"${node.focus.retarget ? ' data-ts-focus-retarget="true"' : ""} visibility="hidden"` : "";
        return `<g${common}${transform}${focus}${extension?.attributes ?? ""}>${extension?.content ?? ""}${node.children.map((child) => renderNode(child, hooks, idPrefix)).join("")}</g>`;
      }
      case "rule":
        return `<line${common} x1="${number(node.x1)}" y1="${number(node.y1)}" x2="${number(node.x2)}" y2="${number(node.y2)}"/>`;
      case "polyline": {
        const path2 = node.path ?? node.points.map(
          ([x2, y2], index) => `${index === 0 ? "M" : "L"}${number(x2)},${number(y2)}`
        ).join("");
        return `<path${common} d="${path2}" vector-effect="non-scaling-stroke"/>`;
      }
      case "area": {
        const path2 = node.polygons !== void 0 ? polygonsPath(node.polygons) : node.path ?? pointsPath(node.points, true);
        const fillRule = node.polygons === void 0 ? "" : ' fill-rule="evenodd"';
        return `<path${common} d="${path2}"${fillRule} vector-effect="non-scaling-stroke"/>`;
      }
      case "dot":
        return `<circle${common} cx="${number(node.x)}" cy="${number(node.y)}" r="${number(node.radius)}"/>`;
      case "rect":
        return `<rect${common} x="${number(node.x)}" y="${number(node.y)}" width="${number(node.width)}" height="${number(node.height)}"${node.radius === void 0 ? "" : ` rx="${number(node.radius)}"`}/>`;
      case "label": {
        const transform = node.rotate === void 0 ? "" : ` transform="rotate(${number(node.rotate)} ${number(node.x)} ${number(node.y)})"`;
        const anchor = node.anchor ? ` text-anchor="${node.anchor}"` : "";
        const baseline = node.baseline ? ` dominant-baseline="${node.baseline}"` : "";
        const fontSize = node.fontSize === void 0 ? "" : ` font-size="${number(node.fontSize)}"`;
        const fontWeight = node.fontWeight === void 0 ? "" : ` font-weight="${number(node.fontWeight)}"`;
        return `<text${common} x="${number(node.x)}" y="${number(node.y)}"${anchor}${baseline}${transform}${fontSize}${fontWeight} font-family="inherit">${escapeText(node.text)}</text>`;
      }
    }
  }
  function polygonsPath(polygons) {
    return polygons.flatMap((polygon) => polygon).filter((ring) => ring.length > 0).map((ring) => pointsPath(ring, true)).join("");
  }
  function pointsPath(points, close) {
    return `${points.map(
      ([x2, y2], index) => `${index === 0 ? "M" : "L"}${number(x2)},${number(y2)}`
    ).join("")}${close ? "Z" : ""}`;
  }
  function renderFocusGuideClip(node, idPrefix) {
    if (!node.clip) return void 0;
    const prefix = idPrefix.replaceAll(/[^a-zA-Z0-9_-]/g, "");
    const id = `${prefix ? `${prefix}-` : ""}ts-chart-clip-${stableId(node.key)}`;
    return {
      attributes: ` clip-path="url(#${id})"`,
      content: `<defs data-ts-key="${escapeAttribute(`${node.key}:clip-defs`)}"><clipPath id="${id}"><rect x="${number(node.clip.x)}" y="${number(node.clip.y)}" width="${number(node.clip.width)}" height="${number(node.clip.height)}"/></clipPath></defs>`
    };
  }
  function stableId(value2) {
    let hash = 2166136261;
    for (let index = 0; index < value2.length; index += 1) {
      hash = Math.imul(hash ^ value2.charCodeAt(index), 16777619);
    }
    return (hash >>> 0).toString(36);
  }
  function renderCommon(node, hooks, idPrefix) {
    const key = ` data-ts-key="${escapeAttribute(node.key)}"`;
    const className = node.className ? ` class="${escapeAttribute(node.className)}"` : "";
    const ariaHidden = node.ariaHidden ? ' aria-hidden="true"' : "";
    return `${key}${className}${ariaHidden}${renderStyle(node.style, hooks, idPrefix)}`;
  }
  function renderStyle(style, hooks, idPrefix) {
    if (!style) return "";
    const paint = (value2) => value2 && hooks?.resolvePaint ? hooks.resolvePaint(value2, idPrefix) : value2;
    const attributes = [
      ["fill", paint(style.fill)],
      ["fill-opacity", style.fillOpacity],
      ["stroke", paint(style.stroke)],
      ["stroke-opacity", style.strokeOpacity],
      ["stroke-width", style.strokeWidth],
      ["opacity", style.opacity],
      ["stroke-linecap", style.lineCap],
      ["stroke-linejoin", style.lineJoin],
      ["stroke-dasharray", style.strokeDasharray]
    ];
    return attributes.filter((entry) => entry[1] != null).map(
      ([name, value2]) => ` ${name}="${typeof value2 === "number" ? number(value2) : escapeAttribute(value2)}"`
    ).join("");
  }
  function number(value2) {
    return String(Math.round(value2 * 100) / 100);
  }
  function escapeText(value2) {
    return value2.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  }
  function escapeAttribute(value2) {
    return escapeText(value2).replaceAll('"', "&quot;");
  }

  // node_modules/@tanstack/charts/dist/svg.js
  function renderChartSvg(scene, options) {
    const gradientIds = new Set(scene.gradients.map((gradient) => gradient.id));
    return renderChartSvgWithHooks(scene, options, {
      renderDefinitions: (currentScene, idPrefix) => renderGradients(currentScene, sanitizeId(idPrefix)),
      renderGroup: (group2, idPrefix) => renderClip(group2, sanitizeId(idPrefix)),
      resolvePaint: (value2, idPrefix) => {
        const match = /^url\(#([^)]+)\)$/.exec(value2);
        const id = match?.[1];
        return id && gradientIds.has(id) ? `url(#${scopedId(sanitizeId(idPrefix), id)})` : value2;
      }
    });
  }
  function renderGradients(scene, idPrefix) {
    if (!scene.gradients.length) return "";
    return `<defs data-ts-key="gradients">${scene.gradients.map(
      (gradient) => `<linearGradient data-ts-key="gradient:${escapeAttribute2(gradient.id)}" id="${escapeAttribute2(scopedId(idPrefix, gradient.id))}" x1="${percent(gradient.x1 ?? 0)}" y1="${percent(gradient.y1 ?? 1)}" x2="${percent(gradient.x2 ?? 0)}" y2="${percent(gradient.y2 ?? 0)}">${gradient.stops.map(
        (stop, index) => `<stop data-ts-key="gradient:${escapeAttribute2(gradient.id)}:stop:${index}" offset="${percent(stop.offset)}" stop-color="${escapeAttribute2(stop.color)}"${stop.opacity === void 0 ? "" : ` stop-opacity="${number2(stop.opacity)}"`}/>`
      ).join("")}</linearGradient>`
    ).join("")}</defs>`;
  }
  function renderClip(group2, idPrefix) {
    if (!group2.clip) return void 0;
    const id = scopedId(idPrefix, `ts-chart-clip-${stableId2(group2.key)}`);
    return {
      attributes: ` clip-path="url(#${id})"`,
      content: `<defs data-ts-key="${escapeAttribute2(`${group2.key}:clip-defs`)}"><clipPath id="${id}"><rect x="${number2(group2.clip.x)}" y="${number2(group2.clip.y)}" width="${number2(group2.clip.width)}" height="${number2(group2.clip.height)}"/></clipPath></defs>`
    };
  }
  function scopedId(prefix, id) {
    return prefix ? `${prefix}-${id}` : id;
  }
  function sanitizeId(value2) {
    return value2.replaceAll(/[^a-zA-Z0-9_-]/g, "");
  }
  function percent(value2) {
    return `${number2(Math.max(0, Math.min(1, value2)) * 100)}%`;
  }
  function stableId2(value2) {
    let hash = 2166136261;
    for (let index = 0; index < value2.length; index += 1) {
      hash = Math.imul(hash ^ value2.charCodeAt(index), 16777619);
    }
    return (hash >>> 0).toString(36);
  }
  function number2(value2) {
    return String(Math.round(value2 * 100) / 100);
  }
  function escapeAttribute2(value2) {
    return value2.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }

  // node_modules/@tanstack/charts/dist/scene-point-ownership-internal.js
  function createScenePointLookup(points) {
    const keys = /* @__PURE__ */ new Map();
    const marks = /* @__PURE__ */ new Map();
    const append2 = (map2, key, point3) => {
      const related = map2.get(key);
      if (related) related.push(point3);
      else map2.set(key, [point3]);
    };
    for (const point3 of points) {
      append2(marks, point3.markId, point3);
      let end = point3.key.length;
      while (end > 0) {
        append2(keys, point3.key.slice(0, end), point3);
        end = point3.key.lastIndexOf(":", end - 1);
      }
    }
    return { points, keys, marks };
  }
  function sceneNodeOwnedPoints(node, scope, lookup, fallback = scope) {
    if (node.kind === "group") {
      const index = node.focusCandidateIndex;
      if (index !== void 0 && Number.isInteger(index) && index >= 0) {
        const point3 = scope[index];
        if (point3) return [point3];
      }
    }
    if (node.pointOwner) {
      const owned = pointCandidates(node.pointOwner, scope);
      if (owned.length) return owned;
    }
    if ("interaction" in node && node.interaction) {
      const candidates = node.interaction.point ? [node.interaction.point] : node.interaction.points;
      const owned = candidates.flatMap(
        (candidate) => pointCandidates(candidate, scope)
      );
      if (owned.length) return owned;
    }
    return sceneKeyOwnedPoints(node.key, scope, lookup, fallback);
  }
  function sceneKeyOwnedPoints(key, scope, lookup, fallback = scope) {
    const withinScope = (candidates) => candidates === void 0 ? [] : scope === lookup.points ? candidates : candidates.filter((point3) => scope.includes(point3));
    const related = withinScope(lookup.keys.get(key));
    const exact = related.filter((point3) => point3.key === key);
    if (exact.length) return exact;
    let candidate = key;
    while (candidate.includes(":")) {
      const separator = candidate.lastIndexOf(":");
      candidate = candidate.slice(0, separator);
      const fragments = withinScope(lookup.keys.get(candidate)).filter(
        (point3) => point3.key === candidate
      );
      if (fragments.length) return fragments;
    }
    if (related.length) return related;
    const mark = withinScope(lookup.marks.get(key));
    if (mark.length) return mark;
    return fallback;
  }
  function pointCandidates(owner, scope) {
    const identical = scope.filter((point3) => point3 === owner);
    if (identical.length) return identical;
    const keyed = scope.filter((point3) => point3.key === owner.key);
    if (keyed.length) return keyed;
    const semantic = scope.filter(
      (point3) => Object.is(point3.datum, owner.datum) && (isReference(owner.datum) || point3.datumIndex === owner.datumIndex)
    );
    return semantic.length === 1 ? semantic : [];
  }
  function isReference(value2) {
    return typeof value2 === "object" && value2 !== null || typeof value2 === "function";
  }

  // node_modules/@tanstack/charts/dist/focus-layer.js
  var emptyPoints = [];
  function resolveFocusGuides(scene, focus, pointer, cursor) {
    const under = [];
    const over = [];
    if (!cursor && !focus) return { under, over };
    for (const guide of scene.focusGuides ?? []) {
      const localFocus = focus && guideOwnsFocus(guide, focus) ? focus : null;
      if (!cursor && focus && !localFocus) continue;
      const node = guide.resolve({
        scene,
        guide,
        focus: localFocus,
        pointer,
        cursor
      });
      if (!node) continue;
      (guide.placement === "under" ? under : over).push(node);
    }
    return { under, over };
  }
  function resolveFocusScene(scene, focus) {
    if (!focus) return { scene, retargeted: false };
    let retargeted = false;
    const visit = (nodes2) => nodes2.map((node) => {
      if (node.kind !== "group") return node;
      if (node.focus?.retarget) {
        const points = node.focus.points.filter(
          (point3) => matchesFocusAnchor(point3, focus, node.focus.match)
        );
        const lookup = createScenePointLookup(node.focus.points);
        const selected = stabilizeSelectedNodes(
          filterNodesWithLookup(
            node.focus.candidates ?? node.children,
            points,
            node.focus.points,
            lookup
          ),
          points,
          node.focus.points,
          lookup,
          node.key
        );
        if (!selected.length) return node;
        retargeted = true;
        return {
          ...node,
          focus: { ...node.focus, activePoints: points },
          children: selected
        };
      }
      const children = visit(node.children);
      return children.some((child, index) => child !== node.children[index]) ? { ...node, children } : node;
    });
    const nodes = visit(scene.nodes);
    return retargeted ? { scene: { ...scene, nodes }, retargeted } : { scene, retargeted };
  }
  function focusedNodeKeys(layer, focus) {
    if (!layer.focus || !focus) return /* @__PURE__ */ new Set();
    const keys = /* @__PURE__ */ new Set();
    visitNodes(selectedFocusChildren(layer, focus), (node) => keys.add(node.key));
    return keys;
  }
  function selectedFocusChildren(layer, focus) {
    const state = layer.focus;
    if (state.retarget) return layer.children;
    if (state.anchors) {
      const anchors = state.anchors.filter(
        (anchor) => matchesFocusAnchor(anchor, focus, state.match)
      );
      return filterNodesByAnchors(layer.children, anchors);
    }
    const points = state.points.filter(
      (point3) => matchesFocusAnchor(point3, focus, state.match)
    );
    return filterNodes(layer.children, points, state.points);
  }
  function filterNodes(nodes, selectedPoints, candidatePoints) {
    return filterNodesWithLookup(
      nodes,
      selectedPoints,
      candidatePoints,
      createScenePointLookup(candidatePoints)
    );
  }
  function filterNodesByAnchors(nodes, anchors) {
    const output = [];
    for (const node of nodes) {
      if (node.kind !== "group") {
        if (anchors.some((anchor) => keysRelate(node.key, anchor.key))) {
          output.push(node);
        }
        continue;
      }
      const children = filterNodesByAnchors(node.children, anchors);
      if (children.length) {
        output.push({ ...node, children });
      } else if (anchors.some((anchor) => anchor.key.startsWith(`${node.key}:`))) {
        output.push(node);
      }
    }
    return output;
  }
  function filterNodesWithLookup(nodes, selectedPoints, candidatePoints, lookup) {
    const output = [];
    for (const node of nodes) {
      if (node.kind !== "group") {
        if (sceneNodeOwnedPoints(node, candidatePoints, lookup, emptyPoints).some(
          (point3) => selectedPoints.includes(point3)
        )) {
          output.push(node);
        }
        continue;
      }
      const structuralPoint = focusCandidatePoint(node, candidatePoints);
      if (structuralPoint) {
        if (selectedPoints.includes(structuralPoint)) output.push(node);
        continue;
      }
      const atomicPoints = atomicGroupPoints(node, candidatePoints, lookup);
      if (atomicPoints.length) {
        if (atomicPoints.some((point3) => selectedPoints.includes(point3))) {
          output.push(node);
        }
        continue;
      }
      const structuralPoints = sceneNodeOwnedPoints(
        node,
        candidatePoints,
        lookup,
        emptyPoints
      );
      const childPoints = structuralPoints.length ? structuralPoints : candidatePoints;
      const children = filterNodesWithLookup(
        node.children,
        selectedPoints,
        childPoints,
        lookup
      );
      if (children.length) {
        output.push({ ...node, children });
      }
    }
    return output;
  }
  function stabilizeSelectedNodes(nodes, points, candidatePoints, lookup, layerKey) {
    const slots = new Map(points.map((point3, index) => [point3, index]));
    const visit = (node, path2) => {
      const related = sceneNodeOwnedPoints(
        node,
        candidatePoints,
        lookup,
        emptyPoints
      ).filter((point22) => slots.has(point22));
      const point3 = related.length === 1 ? related[0] : void 0;
      let key = node.key;
      if (point3 && node.key !== point3.markId) {
        const slot = `${layerKey}:selection:${slots.get(point3) ?? 0}`;
        if (node.key === point3.key) key = slot;
        else if (node.key.startsWith(`${point3.key}:`)) {
          key = `${slot}${node.key.slice(point3.key.length)}`;
        } else if (point3.key.startsWith(`${node.key}:`)) {
          key = `${slot}:ancestor:${path2}`;
        } else {
          key = `${slot}:node:${path2}`;
        }
      }
      return node.kind === "group" ? {
        ...node,
        key,
        children: node.children.map(
          (child, index) => visit(child, `${path2}:${index}`)
        )
      } : { ...node, key };
    };
    return nodes.map((node, index) => visit(node, String(index)));
  }
  function atomicGroupPoints(node, candidatePoints, lookup) {
    const candidate = focusCandidatePoint(node, candidatePoints);
    if (candidate) return [candidate];
    if (node.pointOwner) {
      const owned = sceneNodeOwnedPoints(
        node,
        candidatePoints,
        lookup,
        emptyPoints
      );
      if (owned.length) return owned;
    }
    const exact = lookup.keys.get(node.key)?.filter((point3) => point3.key === node.key);
    return exact === void 0 ? emptyPoints : exact.filter((point3) => candidatePoints.includes(point3));
  }
  function focusCandidatePoint(node, candidatePoints) {
    const index = node.focusCandidateIndex;
    if (index === void 0 || !Number.isInteger(index) || index < 0) {
      return void 0;
    }
    return candidatePoints[index];
  }
  function matchesFocusAnchor(candidate, focus, match) {
    if (match === "x") {
      return candidate.xValue !== void 0 && sameValue(candidate.xValue, focus.primary.xValue);
    }
    if (match === "y") {
      return candidate.yValue !== void 0 && sameValue(candidate.yValue, focus.primary.yValue);
    }
    if (match === "series") {
      return sameValue(candidate.group, focus.primary.group);
    }
    if (match === "key") {
      return candidate.key === focus.primary.key || candidate.datum === focus.primary.datum;
    }
    if (match === "group") {
      return focus.group.some((point3) => sameFocusedPoint(candidate, point3));
    }
    return sameFocusedPoint(candidate, focus.primary);
  }
  function sameFocusedPoint(left2, right2) {
    if (left2 === right2 || left2.key === right2.key) return true;
    if (!Object.is(left2.datum, right2.datum)) return false;
    return isReference2(left2.datum) || left2.datumIndex === right2.datumIndex;
  }
  function keysRelate(left2, right2) {
    return left2 === right2 || left2.startsWith(`${right2}:`) || right2.startsWith(`${left2}:`);
  }
  function sameValue(left2, right2) {
    return valueKey(left2) === valueKey(right2);
  }
  function isReference2(value2) {
    return typeof value2 === "object" && value2 !== null || typeof value2 === "function";
  }
  function visitNodes(nodes, visit) {
    for (const node of nodes) {
      visit(node);
      if (node.kind === "group") visitNodes(node.children, visit);
    }
  }
  function guideOwnsFocus(guide, focus) {
    return guide.scope === void 0 || focus.primary.key === guide.scope || focus.primary.key.startsWith(`${guide.scope}:`);
  }

  // node_modules/@tanstack/charts/dist/svg-focus-guide-serializer.js
  function renderFocusGuideLayerWithRenderer(svg, scene, nodes, placement, options, renderSvg) {
    const document2 = svg.ownerDocument;
    const key = `focus-guide-layer:${placement}`;
    const wrapper = {
      kind: "group",
      key,
      className: `ts-chart__focus-guide-layer ts-chart__focus-guide-layer--${placement}`,
      ariaHidden: true,
      children: nodes
    };
    const markup = renderSvg(
      {
        ...scene,
        nodes: [wrapper],
        focusGuides: void 0
      },
      options
    );
    const root = parseSvgMarkup(document2, markup);
    const layer = root ? keyedElement(root, key) : void 0;
    if (!root || !layer || layer.localName !== "g") {
      throw new Error(
        `The SVG renderer must preserve a g[data-ts-key="${key}"] element when serializing focus guides.`
      );
    }
    layer.classList.add(
      "ts-chart__focus-guide-layer",
      `ts-chart__focus-guide-layer--${placement}`
    );
    layer.setAttribute("data-ts-focus-layer", placement);
    layer.setAttribute("data-ts-focus-guide-layer", placement);
    layer.setAttribute("aria-hidden", "true");
    layer.setAttribute("visibility", nodes.length ? "visible" : "hidden");
    mergeFocusGuideClipFallback(
      document2,
      layer,
      nodes,
      placement,
      options.idPrefix ?? ""
    );
    copyMissingRendererDefinitions(svg, root, layer, key);
    return layer.outerHTML;
  }
  function mergeFocusGuideClipFallback(document2, layer, nodes, placement, idPrefix) {
    const fallback = parseSvgFragment(
      document2,
      renderFocusGuideLayer(nodes, placement, idPrefix)
    );
    if (!fallback) return;
    for (const source of keyedElements(fallback)) {
      const clipPath = source.getAttribute("clip-path");
      const key = source.getAttribute("data-ts-key");
      if (!clipPath || !key) continue;
      const target = keyedElement(layer, key);
      if (!target || target.hasAttribute("clip-path")) continue;
      target.setAttribute("clip-path", clipPath);
      const clipDefinition = keyedElement(fallback, `${key}:clip-defs`);
      if (clipDefinition) {
        target.insertBefore(clipDefinition.cloneNode(true), target.firstChild);
      }
    }
  }
  function copyMissingRendererDefinitions(svg, renderedRoot, layer, layerKey) {
    const pending = [...referencedIds(layer)];
    const visited = /* @__PURE__ */ new Set();
    let definitions;
    while (pending.length) {
      const id = pending.shift();
      if (!id || visited.has(id)) continue;
      visited.add(id);
      if (elementWithId(layer, id) || baseElementWithId(svg, id)) continue;
      const source = elementWithId(renderedRoot, id);
      if (!source) continue;
      if (!definitions) {
        definitions = svg.ownerDocument.createElementNS(
          "http://www.w3.org/2000/svg",
          "defs"
        );
        definitions.setAttribute("data-ts-key", `${layerKey}:renderer-defs`);
        layer.insertBefore(definitions, layer.firstChild);
      }
      const clone = source.cloneNode(true);
      definitions.append(clone);
      pending.push(...referencedIds(clone));
    }
  }
  function baseElementWithId(svg, id) {
    const element = elementWithId(svg, id);
    return element?.closest("[data-ts-focus-guide-layer]") ? void 0 : element;
  }
  function referencedIds(root) {
    const ids = /* @__PURE__ */ new Set();
    for (const element of [root, ...root.querySelectorAll("*")]) {
      for (const attribute of element.attributes) {
        for (const match of attribute.value.matchAll(/url\(#([^)]+)\)/g)) {
          if (match[1]) ids.add(match[1]);
        }
        if ((attribute.localName === "href" || attribute.name === "xlink:href") && attribute.value.startsWith("#")) {
          ids.add(attribute.value.slice(1));
        }
      }
    }
    return ids;
  }
  function elementWithId(root, id) {
    return [
      ...root.getAttribute("id") === id ? [root] : [],
      ...root.querySelectorAll("[id]")
    ].find((element) => element.getAttribute("id") === id);
  }
  function parseSvgMarkup(document2, markup) {
    const template = document2.createElement("template");
    template.innerHTML = markup.trim();
    const root = template.content.firstElementChild;
    return root?.localName === "svg" ? root : void 0;
  }
  function parseSvgFragment(document2, markup) {
    const template = document2.createElement("template");
    template.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`;
    return template.content.firstElementChild?.firstElementChild ?? void 0;
  }
  function keyedElement(root, key) {
    return keyedElements(root).find(
      (element) => element.getAttribute("data-ts-key") === key
    );
  }
  function keyedElements(root) {
    return [
      ...root.hasAttribute("data-ts-key") ? [root] : [],
      ...root.querySelectorAll("[data-ts-key]")
    ];
  }

  // node_modules/@tanstack/charts/dist/svg-focus-guide-layer.js
  function detachSvgFocusGuideLayers(svg) {
    const layers = {};
    if (!svg) return layers;
    for (const placement of ["under", "over"]) {
      const layer = findSvgFocusGuideLayer(svg, placement);
      if (!layer) continue;
      layers[placement] = layer;
      layer.remove();
    }
    return layers;
  }
  function restoreSvgFocusGuideLayers(svg, layers, include = () => true) {
    for (const placement of ["under", "over"]) {
      const layer = layers[placement];
      if (layer && include(placement)) {
        placeSvgFocusGuideLayer(svg, layer, placement);
      }
    }
  }
  function ensureSvgFocusGuideLayer(svg, placement) {
    const existing = findSvgFocusGuideLayer(svg, placement);
    if (existing) return existing;
    const layer = svg.ownerDocument.createElementNS(
      "http://www.w3.org/2000/svg",
      "g"
    );
    layer.dataset.tsKey = `focus-guide-layer:${placement}`;
    layer.dataset.tsFocusLayer = placement;
    layer.dataset.tsFocusGuideLayer = placement;
    layer.setAttribute(
      "class",
      `ts-chart__focus-guide-layer ts-chart__focus-guide-layer--${placement}`
    );
    layer.setAttribute("aria-hidden", "true");
    layer.setAttribute("visibility", "hidden");
    placeSvgFocusGuideLayer(svg, layer, placement);
    return layer;
  }
  function removeSvgFocusGuideLayer(svg, placement) {
    findSvgFocusGuideLayer(svg, placement)?.remove();
  }
  function placeSvgFocusGuideLayer(svg, layer, placement) {
    if (placement === "under") {
      const scene = [...svg.children].find(
        (child) => child.getAttribute("data-ts-key") === "grid" || child.getAttribute("data-ts-key") === "marks" || child.classList.contains("ts-chart__grid") || child.classList.contains("ts-chart__marks")
      );
      svg.insertBefore(layer, scene ?? null);
    } else {
      svg.append(layer);
    }
  }
  function findSvgFocusGuideLayer(svg, placement) {
    return [...svg.children].find(
      (child) => child.localName === "g" && child.getAttribute("data-ts-focus-guide-layer") === placement
    );
  }

  // node_modules/@tanstack/charts/dist/mark-state.js
  function resolveMarkStateScene(scene, focus, pointer = null) {
    if (!focus || !sceneHasMarkStates(scene.nodes)) return { scene };
    let transition;
    const transitions = {};
    const visit = (nodes2, inheritedPoints, definitions, data, inheritedLookup) => nodes2.map((node) => {
      const state = node.kind === "group" ? node.states : void 0;
      const points = state?.points ?? inheritedPoints;
      const nodeDefinitions = state?.definitions ?? definitions;
      const nodeData = state?.data ?? data;
      const lookup = state ? createScenePointLookup(state.points) : inheritedLookup;
      const candidates = points ? lookup ? sceneNodeOwnedPoints(node, points, lookup) : points : emptyPoints2;
      const resolved = node.kind !== "group" && nodeDefinitions && nodeData && candidates.length ? resolveNodeState(
        node,
        candidates,
        nodeData,
        nodeDefinitions,
        focus,
        pointer
      ) : { node };
      if (resolved.transition) {
        transition = mergeTransition(transition, resolved.transition);
        for (const point3 of candidates) {
          transitions[point3.markId] = mergeTransition(
            transitions[point3.markId],
            resolved.transition
          );
        }
      }
      const next = resolved.node;
      return next.kind === "group" ? {
        ...next,
        children: visit(
          next.children,
          candidates.length ? candidates : points,
          nodeDefinitions,
          nodeData,
          lookup
        )
      } : next;
    });
    const nodes = visit(scene.nodes);
    return {
      scene: { ...scene, nodes },
      transition,
      ...Object.keys(transitions).length ? { transitions } : {}
    };
  }
  function sceneHasMarkStates(nodes) {
    return nodes.some(
      (node) => node.kind === "group" && (node.states !== void 0 || sceneHasMarkStates(node.children))
    );
  }
  function resolveNodeState(node, candidates, data, definitions, focus, pointer) {
    let output = node;
    let transition;
    for (const definition2 of definitions) {
      const context = matchingContext(
        candidates,
        data,
        definition2,
        focus,
        pointer
      );
      if (!context) continue;
      output = applyStateStyle(output, definition2.style, context);
      if (definition2.transition) {
        transition = mergeTransition(transition, definition2.transition);
      }
    }
    return { node: output, transition };
  }
  function matchingContext(candidates, data, definition2, focus, pointer) {
    if (typeof definition2.when !== "function" && definition2.when.focus === "unmatched" && candidates.some((point3) => matchesFocusAnchor(point3, focus, "group"))) {
      return void 0;
    }
    for (const point3 of candidates) {
      const context = {
        datum: point3.datum,
        index: point3.datumIndex,
        data,
        point: point3,
        focus,
        pointer,
        matches: (match) => matchesFocusAnchor(point3, focus, match)
      };
      const matches = typeof definition2.when === "function" ? definition2.when(context) : matchesSelector(definition2.when, context);
      if (matches) return context;
    }
    return void 0;
  }
  function matchesSelector(selector, context) {
    const source = selector.source;
    if (source !== void 0 && !(Array.isArray(source) ? source.includes(context.focus.source) : source === context.focus.source)) {
      return false;
    }
    if (selector.pinned !== void 0 && selector.pinned !== context.focus.pinned) {
      return false;
    }
    return selector.focus === "unmatched" ? !context.matches("group") : context.matches(selector.focus);
  }
  function applyStateStyle(node, definition2, context) {
    const style = { ...node.style };
    for (const property of styleProperties) {
      const value2 = resolveValue(definition2[property], context);
      if (value2 !== void 0)
        style[property] = value2;
    }
    let output = { ...node, style };
    const dx = resolveValue(definition2.dx, context) ?? 0;
    const dy = resolveValue(definition2.dy, context) ?? 0;
    const r = resolveValue(definition2.r, context);
    const radius = resolveValue(definition2.radius, context);
    const inset = resolveValue(definition2.inset, context);
    const fontSize = resolveValue(definition2.fontSize, context);
    const fontWeight = resolveValue(definition2.fontWeight, context);
    const rotate = resolveValue(definition2.rotate, context);
    switch (output.kind) {
      case "dot":
        output = {
          ...output,
          x: output.x + dx,
          y: output.y + dy,
          radius: r ?? output.radius
        };
        break;
      case "rect": {
        const currentInset = output.inset ?? 0;
        let nextInset = Math.max(0, inset ?? currentInset);
        if (Number.isFinite(output.maxThickness) && (output.insetAxis === "x" || output.insetAxis === "y")) {
          const currentThickness = output.insetAxis === "x" ? output.width : output.height;
          const bandThickness = currentThickness + currentInset * 2;
          const requestedThickness = Math.max(0, bandThickness - nextInset * 2);
          const cappedThickness = Math.min(
            requestedThickness,
            Math.max(0, output.maxThickness)
          );
          nextInset = (bandThickness - cappedThickness) / 2;
        }
        const amount = nextInset - currentInset;
        const insetX = output.insetAxis !== "y" ? amount : 0;
        const insetY = output.insetAxis !== "x" ? amount : 0;
        output = {
          ...output,
          x: output.x + insetX + dx,
          y: output.y + insetY + dy,
          width: Math.max(0, output.width - insetX * 2),
          height: Math.max(0, output.height - insetY * 2),
          radius: radius ?? output.radius,
          inset: nextInset
        };
        break;
      }
      case "label":
        output = {
          ...output,
          x: output.x + dx,
          y: output.y + dy,
          fontSize: fontSize ?? output.fontSize,
          fontWeight: fontWeight ?? output.fontWeight,
          rotate: rotate ?? output.rotate
        };
        break;
    }
    return output;
  }
  var styleProperties = [
    "fill",
    "fillOpacity",
    "stroke",
    "strokeOpacity",
    "strokeWidth",
    "opacity",
    "strokeDasharray"
  ];
  function resolveValue(value2, context) {
    return typeof value2 === "function" ? value2(context) : value2;
  }
  var emptyPoints2 = [];
  function mergeTransition(current, next) {
    if (!current || current.type !== next.type) return next;
    if (current.type === "spring" && next.type === "spring") {
      return { ...current, ...next };
    }
    if (current.type !== "tween" || next.type !== "tween") return next;
    return {
      ...current,
      ...next,
      duration: Math.max(current.duration ?? 250, next.duration ?? 250)
    };
  }

  // node_modules/@tanstack/charts/dist/mark-state-transition.js
  function resolveMarkStateTransition(transition, element) {
    if (!transition || transition.type !== "tween") return void 0;
    if ((transition.respectReducedMotion ?? true) && element.ownerDocument.defaultView?.matchMedia?.(
      "(prefers-reduced-motion: reduce)"
    ).matches) {
      return void 0;
    }
    const { type: _type, ...resolved } = transition;
    return resolved;
  }

  // node_modules/@tanstack/charts/dist/svg-coordinates.js
  function svgClientToScene(element, scene, clientX, clientY) {
    const matrix = element.getScreenCTM?.();
    if (!matrix) {
      const bounds = element.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return null;
      return {
        x: (clientX - bounds.left) / bounds.width * scene.width,
        y: (clientY - bounds.top) / bounds.height * scene.height
      };
    }
    let inverse;
    try {
      inverse = matrix.inverse();
    } catch {
      return null;
    }
    const x2 = inverse.a * clientX + inverse.c * clientY + inverse.e;
    const y2 = inverse.b * clientX + inverse.d * clientY + inverse.f;
    if (!Number.isFinite(x2) || !Number.isFinite(y2)) return null;
    return { x: x2, y: y2 };
  }

  // node_modules/@tanstack/charts/dist/svg-surface.js
  function createSvgChartRenderer(renderSvg = renderChartSvg) {
    const renderer = {
      id: "svg",
      prerender: renderSvg,
      mount(container) {
        let cancelAnimation = () => {
        };
        let cancelFocusAnimation = () => {
        };
        let scene;
        let renderOptions;
        let stateTransition;
        let markStatePainted = false;
        let retargetedFocus = false;
        const svgElement = () => {
          const svg = container.querySelector("svg.ts-chart");
          if (!svg) {
            throw new Error(
              "The SVG renderer must produce an svg.ts-chart root element."
            );
          }
          return svg;
        };
        const surface = {
          renderer,
          get element() {
            return svgElement();
          },
          render(nextScene, options) {
            const viewportMoved = Boolean(
              scene && viewportTranslationChanged(scene, nextScene)
            );
            cancelAnimation();
            cancelFocusAnimation();
            cancelFocusAnimation = () => {
            };
            const retainsFocusGuideLayers = Boolean(scene?.focusGuides?.length);
            const focusGuideLayers = retainsFocusGuideLayers ? detachSvgFocusGuideLayers(svgElement()) : {};
            cancelAnimation = reconcileChartSvg(
              container,
              renderSvg(nextScene, options),
              viewportMoved ? void 0 : options.animation
            );
            if (retainsFocusGuideLayers) {
              restoreSvgFocusGuideLayers(
                svgElement(),
                focusGuideLayers,
                (placement) => nextScene.focusGuides?.some(
                  (guide) => guide.placement === placement
                ) === true
              );
            }
            scene = nextScene;
            renderOptions = options;
            stateTransition = void 0;
            markStatePainted = false;
            retargetedFocus = false;
          },
          clientToScene(scene2, clientX, clientY) {
            return svgClientToScene(svgElement(), scene2, clientX, clientY);
          },
          paintFocus(focus, pointer, cursor) {
            if (!scene || !renderOptions) return;
            const state = resolveMarkStateScene(scene, focus, pointer);
            const resolved = resolveFocusScene(state.scene, focus);
            const previousTransition = stateTransition;
            if (resolved.scene !== scene || markStatePainted || retargetedFocus || previousTransition) {
              cancelFocusAnimation();
              cancelFocusAnimation = () => {
              };
              const focusGuideLayers = detachSvgFocusGuideLayers(svgElement());
              cancelAnimation();
              cancelAnimation = reconcileChartSvg(
                container,
                renderSvg(resolved.scene, renderOptions),
                resolveMarkStateTransition(
                  state.transition ?? previousTransition,
                  container
                )
              );
              restoreSvgFocusGuideLayers(svgElement(), focusGuideLayers);
            }
            retargetedFocus = resolved.retargeted;
            markStatePainted = Boolean(focus && state.scene !== scene);
            stateTransition = focus ? state.transition ?? previousTransition : void 0;
            paintSvgFocus(svgElement(), resolved.scene, focus);
            cancelFocusAnimation();
            cancelFocusAnimation = paintSvgFocusGuides(
              svgElement(),
              resolved.scene,
              focus,
              pointer,
              cursor,
              renderOptions,
              renderSvg
            );
            return resolved.scene;
          },
          destroy() {
            cancelAnimation();
            cancelFocusAnimation();
          }
        };
        return surface;
      }
    };
    return renderer;
  }
  var svgChartRenderer = createSvgChartRenderer();
  function paintSvgFocus(svg, scene, focus) {
    const sceneLayers = collectFocusLayers(scene.nodes);
    const elements = svg.querySelectorAll(
      "[data-ts-focus-layer]:not([data-ts-focus-guide-layer])"
    );
    elements.forEach((element, index) => {
      const layer = sceneLayers[index];
      const visible = layer ? focusedNodeKeys(layer, focus) : /* @__PURE__ */ new Set();
      element.setAttribute(
        "visibility",
        focus && visible.size ? "visible" : "hidden"
      );
      element.querySelectorAll("[data-ts-key]").forEach((child) => {
        const key = child.dataset.tsKey;
        child.setAttribute(
          "visibility",
          key && visible.has(key) ? "visible" : "hidden"
        );
      });
    });
  }
  function paintSvgFocusGuides(svg, scene, focus, pointer, cursor, renderOptions, renderSvg) {
    const presentation = resolveFocusGuides(scene, focus, pointer, cursor);
    const cancellations = [];
    for (const placement of ["under", "over"]) {
      if (!scene.focusGuides?.some((guide) => guide.placement === placement)) {
        removeSvgFocusGuideLayer(svg, placement);
        continue;
      }
      const layer = ensureSvgFocusGuideLayer(svg, placement);
      const nodes = presentation[placement];
      if (!nodes.length) {
        layer.setAttribute("visibility", "hidden");
        continue;
      }
      const markup = renderSvg === renderChartSvg ? renderFocusGuideLayer(nodes, placement, renderOptions.idPrefix ?? "") : renderFocusGuideLayerWithRenderer(
        svg,
        scene,
        nodes,
        placement,
        renderOptions,
        renderSvg
      );
      cancellations.push(reconcileChartSvgFragment(layer, markup));
    }
    return () => cancellations.forEach((cancel) => cancel());
  }
  function collectFocusLayers(nodes) {
    const layers = [];
    for (const node of nodes) {
      if (node.kind !== "group") continue;
      if (node.focus) {
        layers.push(node);
      } else {
        layers.push(...collectFocusLayers(node.children));
      }
    }
    return layers;
  }

  // node_modules/@tanstack/charts/dist/dom.js
  function mountChart(container, initialOptions, runtime = createChartRuntime()) {
    let renderSvg = initialOptions.renderSvg ?? renderChartSvg;
    let renderer = createSvgChartRenderer(renderSvg);
    const rendererOptions = (options) => {
      const nextRenderSvg = options.renderSvg ?? renderChartSvg;
      if (nextRenderSvg !== renderSvg) {
        renderSvg = nextRenderSvg;
        renderer = createSvgChartRenderer(renderSvg);
      }
      const { renderSvg: _renderSvg, onRender, ...common } = options;
      return {
        ...common,
        renderer,
        onRender: onRender ? ({ container: hostContainer, scene, surface, interaction }) => {
          const svg = surface.defaultElement ?? surface.element;
          const SvgElement = container.ownerDocument.defaultView?.SVGSVGElement;
          if (!SvgElement || !(svg instanceof SvgElement)) {
            throw new TypeError("Expected the SVG chart surface.");
          }
          onRender({
            container: hostContainer,
            scene,
            surface,
            svg,
            interaction
          });
        } : void 0
      };
    };
    const host = mountChartRenderer(
      container,
      rendererOptions(initialOptions),
      runtime
    );
    return {
      interaction: host.interaction,
      update(options) {
        host.update(rendererOptions(options));
      },
      getScene: host.getScene,
      destroy: host.destroy
    };
  }

  // node_modules/d3-array/src/ascending.js
  function ascending(a, b) {
    return a == null || b == null ? NaN : a < b ? -1 : a > b ? 1 : a >= b ? 0 : NaN;
  }

  // node_modules/d3-array/src/descending.js
  function descending(a, b) {
    return a == null || b == null ? NaN : b < a ? -1 : b > a ? 1 : b >= a ? 0 : NaN;
  }

  // node_modules/d3-array/src/bisector.js
  function bisector(f) {
    let compare1, compare2, delta;
    if (f.length !== 2) {
      compare1 = ascending;
      compare2 = (d, x2) => ascending(f(d), x2);
      delta = (d, x2) => f(d) - x2;
    } else {
      compare1 = f === ascending || f === descending ? f : zero;
      compare2 = f;
      delta = f;
    }
    function left2(a, x2, lo = 0, hi = a.length) {
      if (lo < hi) {
        if (compare1(x2, x2) !== 0) return hi;
        do {
          const mid = lo + hi >>> 1;
          if (compare2(a[mid], x2) < 0) lo = mid + 1;
          else hi = mid;
        } while (lo < hi);
      }
      return lo;
    }
    function right2(a, x2, lo = 0, hi = a.length) {
      if (lo < hi) {
        if (compare1(x2, x2) !== 0) return hi;
        do {
          const mid = lo + hi >>> 1;
          if (compare2(a[mid], x2) <= 0) lo = mid + 1;
          else hi = mid;
        } while (lo < hi);
      }
      return lo;
    }
    function center2(a, x2, lo = 0, hi = a.length) {
      const i = left2(a, x2, lo, hi - 1);
      return i > lo && delta(a[i - 1], x2) > -delta(a[i], x2) ? i - 1 : i;
    }
    return { left: left2, center: center2, right: right2 };
  }
  function zero() {
    return 0;
  }

  // node_modules/d3-array/src/number.js
  function number3(x2) {
    return x2 === null ? NaN : +x2;
  }

  // node_modules/d3-array/src/bisect.js
  var ascendingBisect = bisector(ascending);
  var bisectRight = ascendingBisect.right;
  var bisectLeft = ascendingBisect.left;
  var bisectCenter = bisector(number3).center;
  var bisect_default = bisectRight;

  // node_modules/internmap/src/index.js
  var InternMap = class extends Map {
    constructor(entries, key = keyof) {
      super();
      Object.defineProperties(this, { _intern: { value: /* @__PURE__ */ new Map() }, _key: { value: key } });
      if (entries != null) for (const [key2, value2] of entries) this.set(key2, value2);
    }
    get(key) {
      return super.get(intern_get(this, key));
    }
    has(key) {
      return super.has(intern_get(this, key));
    }
    set(key, value2) {
      return super.set(intern_set(this, key), value2);
    }
    delete(key) {
      return super.delete(intern_delete(this, key));
    }
  };
  function intern_get({ _intern, _key }, value2) {
    const key = _key(value2);
    return _intern.has(key) ? _intern.get(key) : value2;
  }
  function intern_set({ _intern, _key }, value2) {
    const key = _key(value2);
    if (_intern.has(key)) return _intern.get(key);
    _intern.set(key, value2);
    return value2;
  }
  function intern_delete({ _intern, _key }, value2) {
    const key = _key(value2);
    if (_intern.has(key)) {
      value2 = _intern.get(key);
      _intern.delete(key);
    }
    return value2;
  }
  function keyof(value2) {
    return value2 !== null && typeof value2 === "object" ? value2.valueOf() : value2;
  }

  // node_modules/d3-array/src/ticks.js
  var e10 = Math.sqrt(50);
  var e5 = Math.sqrt(10);
  var e2 = Math.sqrt(2);
  function tickSpec(start, stop, count2) {
    const step = (stop - start) / Math.max(0, count2), power = Math.floor(Math.log10(step)), error = step / Math.pow(10, power), factor = error >= e10 ? 10 : error >= e5 ? 5 : error >= e2 ? 2 : 1;
    let i1, i2, inc;
    if (power < 0) {
      inc = Math.pow(10, -power) / factor;
      i1 = Math.round(start * inc);
      i2 = Math.round(stop * inc);
      if (i1 / inc < start) ++i1;
      if (i2 / inc > stop) --i2;
      inc = -inc;
    } else {
      inc = Math.pow(10, power) * factor;
      i1 = Math.round(start / inc);
      i2 = Math.round(stop / inc);
      if (i1 * inc < start) ++i1;
      if (i2 * inc > stop) --i2;
    }
    if (i2 < i1 && 0.5 <= count2 && count2 < 2) return tickSpec(start, stop, count2 * 2);
    return [i1, i2, inc];
  }
  function ticks(start, stop, count2) {
    stop = +stop, start = +start, count2 = +count2;
    if (!(count2 > 0)) return [];
    if (start === stop) return [start];
    const reverse = stop < start, [i1, i2, inc] = reverse ? tickSpec(stop, start, count2) : tickSpec(start, stop, count2);
    if (!(i2 >= i1)) return [];
    const n = i2 - i1 + 1, ticks3 = new Array(n);
    if (reverse) {
      if (inc < 0) for (let i = 0; i < n; ++i) ticks3[i] = (i2 - i) / -inc;
      else for (let i = 0; i < n; ++i) ticks3[i] = (i2 - i) * inc;
    } else {
      if (inc < 0) for (let i = 0; i < n; ++i) ticks3[i] = (i1 + i) / -inc;
      else for (let i = 0; i < n; ++i) ticks3[i] = (i1 + i) * inc;
    }
    return ticks3;
  }
  function tickIncrement(start, stop, count2) {
    stop = +stop, start = +start, count2 = +count2;
    return tickSpec(start, stop, count2)[2];
  }
  function tickStep(start, stop, count2) {
    stop = +stop, start = +start, count2 = +count2;
    const reverse = stop < start, inc = reverse ? tickIncrement(stop, start, count2) : tickIncrement(start, stop, count2);
    return (reverse ? -1 : 1) * (inc < 0 ? 1 / -inc : inc);
  }

  // node_modules/d3-array/src/range.js
  function range(start, stop, step) {
    start = +start, stop = +stop, step = (n = arguments.length) < 2 ? (stop = start, start = 0, 1) : n < 3 ? 1 : +step;
    var i = -1, n = Math.max(0, Math.ceil((stop - start) / step)) | 0, range2 = new Array(n);
    while (++i < n) {
      range2[i] = start + i * step;
    }
    return range2;
  }

  // node_modules/d3-scale/src/init.js
  function initRange(domain, range2) {
    switch (arguments.length) {
      case 0:
        break;
      case 1:
        this.range(domain);
        break;
      default:
        this.range(range2).domain(domain);
        break;
    }
    return this;
  }

  // node_modules/d3-scale/src/ordinal.js
  var implicit = /* @__PURE__ */ Symbol("implicit");
  function ordinal() {
    var index = new InternMap(), domain = [], range2 = [], unknown = implicit;
    function scale(d) {
      let i = index.get(d);
      if (i === void 0) {
        if (unknown !== implicit) return unknown;
        index.set(d, i = domain.push(d) - 1);
      }
      return range2[i % range2.length];
    }
    scale.domain = function(_) {
      if (!arguments.length) return domain.slice();
      domain = [], index = new InternMap();
      for (const value2 of _) {
        if (index.has(value2)) continue;
        index.set(value2, domain.push(value2) - 1);
      }
      return scale;
    };
    scale.range = function(_) {
      return arguments.length ? (range2 = Array.from(_), scale) : range2.slice();
    };
    scale.unknown = function(_) {
      return arguments.length ? (unknown = _, scale) : unknown;
    };
    scale.copy = function() {
      return ordinal(domain, range2).unknown(unknown);
    };
    initRange.apply(scale, arguments);
    return scale;
  }

  // node_modules/d3-scale/src/band.js
  function band() {
    var scale = ordinal().unknown(void 0), domain = scale.domain, ordinalRange = scale.range, r0 = 0, r1 = 1, step, bandwidth, round = false, paddingInner = 0, paddingOuter = 0, align = 0.5;
    delete scale.unknown;
    function rescale() {
      var n = domain().length, reverse = r1 < r0, start = reverse ? r1 : r0, stop = reverse ? r0 : r1;
      step = (stop - start) / Math.max(1, n - paddingInner + paddingOuter * 2);
      if (round) step = Math.floor(step);
      start += (stop - start - step * (n - paddingInner)) * align;
      bandwidth = step * (1 - paddingInner);
      if (round) start = Math.round(start), bandwidth = Math.round(bandwidth);
      var values = range(n).map(function(i) {
        return start + step * i;
      });
      return ordinalRange(reverse ? values.reverse() : values);
    }
    scale.domain = function(_) {
      return arguments.length ? (domain(_), rescale()) : domain();
    };
    scale.range = function(_) {
      return arguments.length ? ([r0, r1] = _, r0 = +r0, r1 = +r1, rescale()) : [r0, r1];
    };
    scale.rangeRound = function(_) {
      return [r0, r1] = _, r0 = +r0, r1 = +r1, round = true, rescale();
    };
    scale.bandwidth = function() {
      return bandwidth;
    };
    scale.step = function() {
      return step;
    };
    scale.round = function(_) {
      return arguments.length ? (round = !!_, rescale()) : round;
    };
    scale.padding = function(_) {
      return arguments.length ? (paddingInner = Math.min(1, paddingOuter = +_), rescale()) : paddingInner;
    };
    scale.paddingInner = function(_) {
      return arguments.length ? (paddingInner = Math.min(1, _), rescale()) : paddingInner;
    };
    scale.paddingOuter = function(_) {
      return arguments.length ? (paddingOuter = +_, rescale()) : paddingOuter;
    };
    scale.align = function(_) {
      return arguments.length ? (align = Math.max(0, Math.min(1, _)), rescale()) : align;
    };
    scale.copy = function() {
      return band(domain(), [r0, r1]).round(round).paddingInner(paddingInner).paddingOuter(paddingOuter).align(align);
    };
    return initRange.apply(rescale(), arguments);
  }

  // node_modules/d3-format/src/formatDecimal.js
  function formatDecimal_default(x2) {
    return Math.abs(x2 = Math.round(x2)) >= 1e21 ? x2.toLocaleString("en").replace(/,/g, "") : x2.toString(10);
  }
  function formatDecimalParts(x2, p) {
    if (!isFinite(x2) || x2 === 0) return null;
    var i = (x2 = p ? x2.toExponential(p - 1) : x2.toExponential()).indexOf("e"), coefficient = x2.slice(0, i);
    return [
      coefficient.length > 1 ? coefficient[0] + coefficient.slice(2) : coefficient,
      +x2.slice(i + 1)
    ];
  }

  // node_modules/d3-format/src/exponent.js
  function exponent_default(x2) {
    return x2 = formatDecimalParts(Math.abs(x2)), x2 ? x2[1] : NaN;
  }

  // node_modules/d3-format/src/formatGroup.js
  function formatGroup_default(grouping, thousands) {
    return function(value2, width) {
      var i = value2.length, t = [], j = 0, g = grouping[0], length = 0;
      while (i > 0 && g > 0) {
        if (length + g + 1 > width) g = Math.max(1, width - length);
        t.push(value2.substring(i -= g, i + g));
        if ((length += g + 1) > width) break;
        g = grouping[j = (j + 1) % grouping.length];
      }
      return t.reverse().join(thousands);
    };
  }

  // node_modules/d3-format/src/formatNumerals.js
  function formatNumerals_default(numerals) {
    return function(value2) {
      return value2.replace(/[0-9]/g, function(i) {
        return numerals[+i];
      });
    };
  }

  // node_modules/d3-format/src/formatSpecifier.js
  var re = /^(?:(.)?([<>=^]))?([+\-( ])?([$#])?(0)?(\d+)?(,)?(\.\d+)?(~)?([a-z%])?$/i;
  function formatSpecifier(specifier) {
    if (!(match = re.exec(specifier))) throw new Error("invalid format: " + specifier);
    var match;
    return new FormatSpecifier({
      fill: match[1],
      align: match[2],
      sign: match[3],
      symbol: match[4],
      zero: match[5],
      width: match[6],
      comma: match[7],
      precision: match[8] && match[8].slice(1),
      trim: match[9],
      type: match[10]
    });
  }
  formatSpecifier.prototype = FormatSpecifier.prototype;
  function FormatSpecifier(specifier) {
    this.fill = specifier.fill === void 0 ? " " : specifier.fill + "";
    this.align = specifier.align === void 0 ? ">" : specifier.align + "";
    this.sign = specifier.sign === void 0 ? "-" : specifier.sign + "";
    this.symbol = specifier.symbol === void 0 ? "" : specifier.symbol + "";
    this.zero = !!specifier.zero;
    this.width = specifier.width === void 0 ? void 0 : +specifier.width;
    this.comma = !!specifier.comma;
    this.precision = specifier.precision === void 0 ? void 0 : +specifier.precision;
    this.trim = !!specifier.trim;
    this.type = specifier.type === void 0 ? "" : specifier.type + "";
  }
  FormatSpecifier.prototype.toString = function() {
    return this.fill + this.align + this.sign + this.symbol + (this.zero ? "0" : "") + (this.width === void 0 ? "" : Math.max(1, this.width | 0)) + (this.comma ? "," : "") + (this.precision === void 0 ? "" : "." + Math.max(0, this.precision | 0)) + (this.trim ? "~" : "") + this.type;
  };

  // node_modules/d3-format/src/formatTrim.js
  function formatTrim_default(s) {
    out: for (var n = s.length, i = 1, i0 = -1, i1; i < n; ++i) {
      switch (s[i]) {
        case ".":
          i0 = i1 = i;
          break;
        case "0":
          if (i0 === 0) i0 = i;
          i1 = i;
          break;
        default:
          if (!+s[i]) break out;
          if (i0 > 0) i0 = 0;
          break;
      }
    }
    return i0 > 0 ? s.slice(0, i0) + s.slice(i1 + 1) : s;
  }

  // node_modules/d3-format/src/formatPrefixAuto.js
  var prefixExponent;
  function formatPrefixAuto_default(x2, p) {
    var d = formatDecimalParts(x2, p);
    if (!d) return prefixExponent = void 0, x2.toPrecision(p);
    var coefficient = d[0], exponent = d[1], i = exponent - (prefixExponent = Math.max(-8, Math.min(8, Math.floor(exponent / 3))) * 3) + 1, n = coefficient.length;
    return i === n ? coefficient : i > n ? coefficient + new Array(i - n + 1).join("0") : i > 0 ? coefficient.slice(0, i) + "." + coefficient.slice(i) : "0." + new Array(1 - i).join("0") + formatDecimalParts(x2, Math.max(0, p + i - 1))[0];
  }

  // node_modules/d3-format/src/formatRounded.js
  function formatRounded_default(x2, p) {
    var d = formatDecimalParts(x2, p);
    if (!d) return x2 + "";
    var coefficient = d[0], exponent = d[1];
    return exponent < 0 ? "0." + new Array(-exponent).join("0") + coefficient : coefficient.length > exponent + 1 ? coefficient.slice(0, exponent + 1) + "." + coefficient.slice(exponent + 1) : coefficient + new Array(exponent - coefficient.length + 2).join("0");
  }

  // node_modules/d3-format/src/formatTypes.js
  var formatTypes_default = {
    "%": (x2, p) => (x2 * 100).toFixed(p),
    "b": (x2) => Math.round(x2).toString(2),
    "c": (x2) => x2 + "",
    "d": formatDecimal_default,
    "e": (x2, p) => x2.toExponential(p),
    "f": (x2, p) => x2.toFixed(p),
    "g": (x2, p) => x2.toPrecision(p),
    "o": (x2) => Math.round(x2).toString(8),
    "p": (x2, p) => formatRounded_default(x2 * 100, p),
    "r": formatRounded_default,
    "s": formatPrefixAuto_default,
    "X": (x2) => Math.round(x2).toString(16).toUpperCase(),
    "x": (x2) => Math.round(x2).toString(16)
  };

  // node_modules/d3-format/src/identity.js
  function identity_default(x2) {
    return x2;
  }

  // node_modules/d3-format/src/locale.js
  var map = Array.prototype.map;
  var prefixes = ["y", "z", "a", "f", "p", "n", "\xB5", "m", "", "k", "M", "G", "T", "P", "E", "Z", "Y"];
  function locale_default(locale2) {
    var group2 = locale2.grouping === void 0 || locale2.thousands === void 0 ? identity_default : formatGroup_default(map.call(locale2.grouping, Number), locale2.thousands + ""), currencyPrefix = locale2.currency === void 0 ? "" : locale2.currency[0] + "", currencySuffix = locale2.currency === void 0 ? "" : locale2.currency[1] + "", decimal = locale2.decimal === void 0 ? "." : locale2.decimal + "", numerals = locale2.numerals === void 0 ? identity_default : formatNumerals_default(map.call(locale2.numerals, String)), percent2 = locale2.percent === void 0 ? "%" : locale2.percent + "", minus = locale2.minus === void 0 ? "\u2212" : locale2.minus + "", nan = locale2.nan === void 0 ? "NaN" : locale2.nan + "";
    function newFormat(specifier, options) {
      specifier = formatSpecifier(specifier);
      var fill = specifier.fill, align = specifier.align, sign2 = specifier.sign, symbol = specifier.symbol, zero2 = specifier.zero, width = specifier.width, comma = specifier.comma, precision = specifier.precision, trim = specifier.trim, type = specifier.type;
      if (type === "n") comma = true, type = "g";
      else if (!formatTypes_default[type]) precision === void 0 && (precision = 12), trim = true, type = "g";
      if (zero2 || fill === "0" && align === "=") zero2 = true, fill = "0", align = "=";
      var prefix = (options && options.prefix !== void 0 ? options.prefix : "") + (symbol === "$" ? currencyPrefix : symbol === "#" && /[boxX]/.test(type) ? "0" + type.toLowerCase() : ""), suffix = (symbol === "$" ? currencySuffix : /[%p]/.test(type) ? percent2 : "") + (options && options.suffix !== void 0 ? options.suffix : "");
      var formatType = formatTypes_default[type], maybeSuffix = /[defgprs%]/.test(type);
      precision = precision === void 0 ? 6 : /[gprs]/.test(type) ? Math.max(1, Math.min(21, precision)) : Math.max(0, Math.min(20, precision));
      function format2(value2) {
        var valuePrefix = prefix, valueSuffix = suffix, i, n, c;
        if (type === "c") {
          valueSuffix = formatType(value2) + valueSuffix;
          value2 = "";
        } else {
          value2 = +value2;
          var valueNegative = value2 < 0 || 1 / value2 < 0;
          value2 = isNaN(value2) ? nan : formatType(Math.abs(value2), precision);
          if (trim) value2 = formatTrim_default(value2);
          if (valueNegative && +value2 === 0 && sign2 !== "+") valueNegative = false;
          valuePrefix = (valueNegative ? sign2 === "(" ? sign2 : minus : sign2 === "-" || sign2 === "(" ? "" : sign2) + valuePrefix;
          valueSuffix = (type === "s" && !isNaN(value2) && prefixExponent !== void 0 ? prefixes[8 + prefixExponent / 3] : "") + valueSuffix + (valueNegative && sign2 === "(" ? ")" : "");
          if (maybeSuffix) {
            i = -1, n = value2.length;
            while (++i < n) {
              if (c = value2.charCodeAt(i), 48 > c || c > 57) {
                valueSuffix = (c === 46 ? decimal + value2.slice(i + 1) : value2.slice(i)) + valueSuffix;
                value2 = value2.slice(0, i);
                break;
              }
            }
          }
        }
        if (comma && !zero2) value2 = group2(value2, Infinity);
        var length = valuePrefix.length + value2.length + valueSuffix.length, padding = length < width ? new Array(width - length + 1).join(fill) : "";
        if (comma && zero2) value2 = group2(padding + value2, padding.length ? width - valueSuffix.length : Infinity), padding = "";
        switch (align) {
          case "<":
            value2 = valuePrefix + value2 + valueSuffix + padding;
            break;
          case "=":
            value2 = valuePrefix + padding + value2 + valueSuffix;
            break;
          case "^":
            value2 = padding.slice(0, length = padding.length >> 1) + valuePrefix + value2 + valueSuffix + padding.slice(length);
            break;
          default:
            value2 = padding + valuePrefix + value2 + valueSuffix;
            break;
        }
        return numerals(value2);
      }
      format2.toString = function() {
        return specifier + "";
      };
      return format2;
    }
    function formatPrefix2(specifier, value2) {
      var e = Math.max(-8, Math.min(8, Math.floor(exponent_default(value2) / 3))) * 3, k = Math.pow(10, -e), f = newFormat((specifier = formatSpecifier(specifier), specifier.type = "f", specifier), { suffix: prefixes[8 + e / 3] });
      return function(value3) {
        return f(k * value3);
      };
    }
    return {
      format: newFormat,
      formatPrefix: formatPrefix2
    };
  }

  // node_modules/d3-format/src/defaultLocale.js
  var locale;
  var format;
  var formatPrefix;
  defaultLocale({
    thousands: ",",
    grouping: [3],
    currency: ["$", ""]
  });
  function defaultLocale(definition2) {
    locale = locale_default(definition2);
    format = locale.format;
    formatPrefix = locale.formatPrefix;
    return locale;
  }

  // node_modules/d3-format/src/precisionFixed.js
  function precisionFixed_default(step) {
    return Math.max(0, -exponent_default(Math.abs(step)));
  }

  // node_modules/d3-format/src/precisionPrefix.js
  function precisionPrefix_default(step, value2) {
    return Math.max(0, Math.max(-8, Math.min(8, Math.floor(exponent_default(value2) / 3))) * 3 - exponent_default(Math.abs(step)));
  }

  // node_modules/d3-format/src/precisionRound.js
  function precisionRound_default(step, max3) {
    step = Math.abs(step), max3 = Math.abs(max3) - step;
    return Math.max(0, exponent_default(max3) - exponent_default(step)) + 1;
  }

  // node_modules/d3-scale/src/tickFormat.js
  function tickFormat(start, stop, count2, specifier) {
    var step = tickStep(start, stop, count2), precision;
    specifier = formatSpecifier(specifier == null ? ",f" : specifier);
    switch (specifier.type) {
      case "s": {
        var value2 = Math.max(Math.abs(start), Math.abs(stop));
        if (specifier.precision == null && !isNaN(precision = precisionPrefix_default(step, value2))) specifier.precision = precision;
        return formatPrefix(specifier, value2);
      }
      case "":
      case "e":
      case "g":
      case "p":
      case "r": {
        if (specifier.precision == null && !isNaN(precision = precisionRound_default(step, Math.max(Math.abs(start), Math.abs(stop))))) specifier.precision = precision - (specifier.type === "e");
        break;
      }
      case "f":
      case "%": {
        if (specifier.precision == null && !isNaN(precision = precisionFixed_default(step))) specifier.precision = precision - (specifier.type === "%") * 2;
        break;
      }
    }
    return format(specifier);
  }

  // node_modules/d3-scale/src/linear.js
  function linearish(scale) {
    var domain = scale.domain;
    scale.ticks = function(count2) {
      var d = domain();
      return ticks(d[0], d[d.length - 1], count2 == null ? 10 : count2);
    };
    scale.tickFormat = function(count2, specifier) {
      var d = domain();
      return tickFormat(d[0], d[d.length - 1], count2 == null ? 10 : count2, specifier);
    };
    scale.nice = function(count2) {
      if (count2 == null) count2 = 10;
      var d = domain();
      var i0 = 0;
      var i1 = d.length - 1;
      var start = d[i0];
      var stop = d[i1];
      var prestep;
      var step;
      var maxIter = 10;
      if (stop < start) {
        step = start, start = stop, stop = step;
        step = i0, i0 = i1, i1 = step;
      }
      while (maxIter-- > 0) {
        step = tickIncrement(start, stop, count2);
        if (step === prestep) {
          d[i0] = start;
          d[i1] = stop;
          return domain(d);
        } else if (step > 0) {
          start = Math.floor(start / step) * step;
          stop = Math.ceil(stop / step) * step;
        } else if (step < 0) {
          start = Math.ceil(start * step) / step;
          stop = Math.floor(stop * step) / step;
        } else {
          break;
        }
        prestep = step;
      }
      return scale;
    };
    return scale;
  }

  // node_modules/d3-scale/src/quantize.js
  function quantize() {
    var x0 = 0, x1 = 1, n = 1, domain = [0.5], range2 = [0, 1], unknown;
    function scale(x2) {
      return x2 != null && x2 <= x2 ? range2[bisect_default(domain, x2, 0, n)] : unknown;
    }
    function rescale() {
      var i = -1;
      domain = new Array(n);
      while (++i < n) domain[i] = ((i + 1) * x1 - (i - n) * x0) / (n + 1);
      return scale;
    }
    scale.domain = function(_) {
      return arguments.length ? ([x0, x1] = _, x0 = +x0, x1 = +x1, rescale()) : [x0, x1];
    };
    scale.range = function(_) {
      return arguments.length ? (n = (range2 = Array.from(_)).length - 1, rescale()) : range2.slice();
    };
    scale.invertExtent = function(y2) {
      var i = range2.indexOf(y2);
      return i < 0 ? [NaN, NaN] : i < 1 ? [x0, domain[0]] : i >= n ? [domain[n - 1], x1] : [domain[i - 1], domain[i]];
    };
    scale.unknown = function(_) {
      return arguments.length ? (unknown = _, scale) : scale;
    };
    scale.thresholds = function() {
      return domain.slice();
    };
    scale.copy = function() {
      return quantize().domain([x0, x1]).range(range2).unknown(unknown);
    };
    return initRange.apply(linearish(scale), arguments);
  }

  // node_modules/@tanstack/charts/dist/bar.js
  function barY(source, options = {}) {
    const data = Array.isArray(source) ? source : Array.from(source);
    const xScale = options.xScale ?? "x";
    const yScale = options.yScale ?? "y";
    return createMark(
      ({ markIndex }) => {
        const id = options.id ?? `bar-y-${markIndex}`;
        const xValues = channelValues(
          data,
          options.x,
          (_datum, { index }) => index
        );
        const rawYValues = numericChannelValues(
          data,
          options.y ?? options.y2,
          (datum) => typeof datum === "number" ? datum : void 0
        );
        const zValues = channelValues(data, options.z, () => null);
        const colorValues = options.color === void 0 ? zValues : channelValues(data, options.color, () => null);
        const seriesValues = options.z === void 0 && options.color !== void 0 ? colorValues : zValues;
        const explicitExtent = options.y1 !== void 0 || options.y2 !== void 0;
        if (explicitExtent && options.layout?.type === "stack") {
          throw new TypeError(
            "A bar with explicit y1 or y2 endpoints cannot also configure a stack layout"
          );
        }
        const grouped = options.layout?.type === "group";
        const stackLayout = options.layout?.type === "stack" ? options.layout : {};
        const stacked = !explicitExtent && !grouped ? stackValues(xValues, rawYValues, seriesValues, stackLayout, "index") : void 0;
        const y1Values = explicitExtent ? numericChannelValues(data, options.y1, () => 0) : stacked?.starts ?? data.map(() => 0);
        const y2Values = explicitExtent ? numericChannelValues(data, options.y2 ?? options.y, () => void 0) : grouped ? rawYValues : stacked.ends;
        const duplicatePositions = hasDuplicateValues(xValues);
        const groupValues = grouped || !explicitExtent && duplicatePositions ? seriesValues : zValues;
        const keys = inferredKeyValues(data, options.key, {
          groups: groupValues,
          candidates: [xValues],
          markId: id,
          warningIdentity: options
        });
        return {
          id,
          states: markStates(data, options.states),
          seriesFromColor: options.z === void 0 && options.color !== void 0 && (grouped || duplicatePositions),
          channels: {
            x: { scale: xScale, values: xValues.filter(isChartValue) },
            y: {
              scale: yScale,
              values: [
                ...y2Values.filter(isFiniteNumber),
                ...y1Values.filter(isFiniteNumber)
              ],
              includeZero: options.y1 === void 0
            },
            color: {
              scale: "color",
              values: colorValues.filter(isChartKey)
            }
          },
          render: ({ scales, chart, color: resolveColor }) => {
            const totalBandwidth = scales[xScale].bandwidth || inferBandwidth(scales[xScale], xValues, chart.width, data.length);
            const groupScale = resolveGroupScale(
              options.layout?.type === "group" ? options.layout : void 0,
              groupValues,
              totalBandwidth
            );
            const groupBandwidth = groupScale?.bandwidth ?? totalBandwidth;
            const thickness = resolveBarThickness(
              groupBandwidth,
              options.inset,
              options.maxThickness
            );
            const nodes = [];
            data.forEach((datum, datumIndex) => {
              const xValue = xValues[datumIndex];
              const yValue = rawYValues[datumIndex];
              const y1Value = y1Values[datumIndex];
              const y2Value = y2Values[datumIndex];
              if (!isChartValue(xValue) || !isFiniteNumber(yValue) || !isFiniteNumber(y1Value) || !isFiniteNumber(y2Value))
                return;
              const group2 = groupValues[datumIndex] ?? null;
              const groupOffset = groupScale?.map(group2) ?? 0;
              const resolvedColor = resolveColor(colorValues[datumIndex]);
              const fill = visualValue(
                options.fill,
                datum,
                datumIndex,
                data,
                resolvedColor
              );
              const stroke = visualValue(
                options.stroke,
                datum,
                datumIndex,
                data,
                "none"
              );
              const strokeDasharray = visualValue(
                options.strokeDasharray,
                datum,
                datumIndex,
                data,
                "none"
              );
              const center2 = scales[xScale].map(xValue);
              const baselinePosition = scales[yScale].map(y1Value);
              const valuePosition = scales[yScale].map(y2Value);
              const x2 = center2 - totalBandwidth / 2 + groupOffset + thickness.inset;
              const y2 = Math.min(baselinePosition, valuePosition);
              const width = thickness.size;
              const height = Math.abs(baselinePosition - valuePosition);
              const key = `${id}:${valueKey(group2)}:${valueKey(keys[datumIndex])}`;
              const point3 = {
                key,
                markId: id,
                group: group2,
                groupLabel: group2 == null ? id : String(group2),
                datum,
                datumIndex,
                xValue,
                yValue,
                y1Value,
                y2Value,
                yInterval: "difference",
                x: center2 - totalBandwidth / 2 + groupOffset + groupBandwidth / 2,
                y: valuePosition,
                color: fill
              };
              nodes.push({
                kind: "rect",
                key,
                x: x2,
                y: y2,
                width,
                height,
                radius: options.radius,
                inset: thickness.inset,
                insetAxis: "x",
                ...thickness.maximum === void 0 ? {} : { maxThickness: thickness.maximum },
                interaction: { point: point3, affinity: "x" },
                style: {
                  fill,
                  fillOpacity: options.fillOpacity,
                  stroke,
                  strokeOpacity: options.strokeOpacity,
                  strokeWidth: options.strokeWidth,
                  strokeDasharray
                }
              });
            });
            return {
              nodes: [
                {
                  kind: "group",
                  key: id,
                  className: "ts-chart__bar ts-chart__bar-y",
                  ariaHidden: true,
                  children: nodes
                }
              ]
            };
          }
        };
      },
      options.motion,
      options.renderer
    );
  }
  function barX(source, options = {}) {
    const data = Array.isArray(source) ? source : Array.from(source);
    const xScale = options.xScale ?? "x";
    const yScale = options.yScale ?? "y";
    return createMark(
      ({ markIndex }) => {
        const id = options.id ?? `bar-x-${markIndex}`;
        const rawXValues = numericChannelValues(
          data,
          options.x ?? options.x2,
          (datum) => typeof datum === "number" ? datum : void 0
        );
        const yValues = channelValues(
          data,
          options.y,
          (_datum, { index }) => index
        );
        const zValues = channelValues(data, options.z, () => null);
        const colorValues = options.color === void 0 ? zValues : channelValues(data, options.color, () => null);
        const seriesValues = options.z === void 0 && options.color !== void 0 ? colorValues : zValues;
        const explicitExtent = options.x1 !== void 0 || options.x2 !== void 0;
        if (explicitExtent && options.layout?.type === "stack") {
          throw new TypeError(
            "A bar with explicit x1 or x2 endpoints cannot also configure a stack layout"
          );
        }
        const grouped = options.layout?.type === "group";
        const stackLayout = options.layout?.type === "stack" ? options.layout : {};
        const stacked = !explicitExtent && !grouped ? stackValues(yValues, rawXValues, seriesValues, stackLayout, "index") : void 0;
        const x1Values = explicitExtent ? numericChannelValues(data, options.x1, () => 0) : stacked?.starts ?? data.map(() => 0);
        const x2Values = explicitExtent ? numericChannelValues(data, options.x2 ?? options.x, () => void 0) : grouped ? rawXValues : stacked.ends;
        const duplicatePositions = hasDuplicateValues(yValues);
        const groupValues = grouped || !explicitExtent && duplicatePositions ? seriesValues : zValues;
        const keys = inferredKeyValues(data, options.key, {
          groups: groupValues,
          candidates: [yValues],
          markId: id,
          warningIdentity: options
        });
        return {
          id,
          states: markStates(data, options.states),
          seriesFromColor: options.z === void 0 && options.color !== void 0 && (grouped || duplicatePositions),
          channels: {
            x: {
              scale: xScale,
              values: [
                ...x2Values.filter(isFiniteNumber),
                ...x1Values.filter(isFiniteNumber)
              ],
              includeZero: options.x1 === void 0
            },
            y: { scale: yScale, values: yValues.filter(isChartValue) },
            color: {
              scale: "color",
              values: colorValues.filter(isChartKey)
            }
          },
          render: ({ scales, chart, color: resolveColor }) => {
            const totalBandwidth = scales[yScale].bandwidth || inferBandwidth(scales[yScale], yValues, chart.height, data.length);
            const groupScale = resolveGroupScale(
              options.layout?.type === "group" ? options.layout : void 0,
              groupValues,
              totalBandwidth
            );
            const groupBandwidth = groupScale?.bandwidth ?? totalBandwidth;
            const thickness = resolveBarThickness(
              groupBandwidth,
              options.inset,
              options.maxThickness
            );
            const nodes = [];
            data.forEach((datum, datumIndex) => {
              const xValue = rawXValues[datumIndex];
              const x1Value = x1Values[datumIndex];
              const x2Value = x2Values[datumIndex];
              const yValue = yValues[datumIndex];
              if (!isFiniteNumber(xValue) || !isFiniteNumber(x1Value) || !isFiniteNumber(x2Value) || !isChartValue(yValue))
                return;
              const group2 = groupValues[datumIndex] ?? null;
              const groupOffset = groupScale?.map(group2) ?? 0;
              const resolvedColor = resolveColor(colorValues[datumIndex]);
              const fill = visualValue(
                options.fill,
                datum,
                datumIndex,
                data,
                resolvedColor
              );
              const stroke = visualValue(
                options.stroke,
                datum,
                datumIndex,
                data,
                "none"
              );
              const strokeDasharray = visualValue(
                options.strokeDasharray,
                datum,
                datumIndex,
                data,
                "none"
              );
              const baselinePosition = scales[xScale].map(x1Value);
              const valuePosition = scales[xScale].map(x2Value);
              const center2 = scales[yScale].map(yValue);
              const y2 = center2 - totalBandwidth / 2 + groupOffset + thickness.inset;
              const x2 = Math.min(baselinePosition, valuePosition);
              const width = Math.abs(baselinePosition - valuePosition);
              const height = thickness.size;
              const key = `${id}:${valueKey(group2)}:${valueKey(keys[datumIndex])}`;
              const point3 = {
                key,
                markId: id,
                group: group2,
                groupLabel: group2 == null ? id : String(group2),
                datum,
                datumIndex,
                xValue,
                yValue,
                x1Value,
                x2Value,
                xInterval: "difference",
                x: valuePosition,
                y: center2 - totalBandwidth / 2 + groupOffset + groupBandwidth / 2,
                color: fill
              };
              nodes.push({
                kind: "rect",
                key,
                x: x2,
                y: y2,
                width,
                height,
                radius: options.radius,
                inset: thickness.inset,
                insetAxis: "y",
                ...thickness.maximum === void 0 ? {} : { maxThickness: thickness.maximum },
                interaction: { point: point3, affinity: "y" },
                style: {
                  fill,
                  fillOpacity: options.fillOpacity,
                  stroke,
                  strokeOpacity: options.strokeOpacity,
                  strokeWidth: options.strokeWidth,
                  strokeDasharray
                }
              });
            });
            return {
              nodes: [
                {
                  kind: "group",
                  key: id,
                  className: "ts-chart__bar ts-chart__bar-x",
                  ariaHidden: true,
                  children: nodes
                }
              ]
            };
          }
        };
      },
      options.motion,
      options.renderer
    );
  }
  function resolveBarThickness(bandwidth, insetOption, maxThicknessOption) {
    const authoredInset = Math.max(0, insetOption ?? 0);
    const resolvedBandwidth = Math.max(0, bandwidth);
    const available = Math.max(0, resolvedBandwidth - authoredInset * 2);
    const constrained = Number.isFinite(maxThicknessOption);
    const maximum = constrained ? Math.max(0, maxThicknessOption) : available;
    const size = Math.min(available, maximum);
    return {
      inset: (resolvedBandwidth - size) / 2,
      maximum: constrained ? maximum : void 0,
      size
    };
  }
  function resolveGroupScale(source, values, bandwidth) {
    if (!source) return void 0;
    const scale = resolveScaleInput(
      source.scale ?? (() => band().padding(
        Number.isFinite(source.padding) ? Math.max(0, source.padding) : 0.1
      )),
      { values }
    );
    scale.range([0, bandwidth]);
    const groupBandwidth = scale.bandwidth?.();
    if (groupBandwidth === void 0) {
      throw new TypeError("A grouped bar layout requires a D3 band scale");
    }
    return {
      bandwidth: groupBandwidth,
      map(value2) {
        if (value2 === null) {
          throw new TypeError(
            "A grouped bar requires an explicit z channel or a discrete color channel"
          );
        }
        const position = scale(value2);
        if (position === void 0 || !Number.isFinite(position)) {
          throw new TypeError(
            `Bar group value "${String(value2)}" is outside the group layout scale domain`
          );
        }
        return position;
      }
    };
  }
  function hasDuplicateValues(values) {
    const seen = /* @__PURE__ */ new Set();
    for (const value2 of values) {
      if (!isChartValue(value2)) continue;
      const identity = valueKey(value2);
      if (seen.has(identity)) return true;
      seen.add(identity);
    }
    return false;
  }
  function inferBandwidth(scale, values, span, count2) {
    const positions = [
      ...new Set(
        values.filter(isChartValue).map(scale.map).filter((value2) => Number.isFinite(value2))
      )
    ].sort((a, b) => a - b);
    let minimum = Infinity;
    for (let index = 1; index < positions.length; index += 1) {
      minimum = Math.min(minimum, positions[index] - positions[index - 1]);
    }
    return Number.isFinite(minimum) ? minimum * 0.8 : Math.min(48, span / Math.max(2, count2 + 1) * 0.8);
  }
  function numericChannelValues(data, channel, fallback) {
    return typeof channel === "number" ? data.map(() => channel) : channelValues(data, channel, fallback);
  }

  // node_modules/@tanstack/charts/dist/mark-with-scale-values.js
  function createMarkWithScaleValues(initialize, motion, renderer) {
    const normalizedInitialize = (context) => {
      const initialized = normalizeMarkInitialization(initialize(context));
      const withMotion = motion === void 0 || initialized.motion !== void 0 ? initialized : { ...initialized, motion };
      return renderer === void 0 ? withMotion : applyMarkRenderer(withMotion, renderer);
    };
    return {
      initialize: normalizedInitialize,
      ...motion === void 0 ? {} : { motion },
      ...renderer === void 0 ? {} : { renderer }
    };
  }

  // node_modules/@tanstack/charts/dist/mapped-spacing-internal.js
  function minimumMappedSpacing(scale, values) {
    const positions = [
      ...new Set(
        values.filter(isChartValue).map(scale.map).filter((value2) => Number.isFinite(value2))
      )
    ].sort((left2, right2) => left2 - right2);
    let minimum = Infinity;
    for (let index = 1; index < positions.length; index += 1) {
      const distance = positions[index] - positions[index - 1];
      if (distance > 0) minimum = Math.min(minimum, distance);
    }
    return Number.isFinite(minimum) ? minimum : void 0;
  }
  function resolvedCategoryStep(scale, plotSpan, fitUnits = 1) {
    const spacing = minimumMappedSpacing(scale, scale.domain);
    if (spacing !== void 0) return spacing;
    const fitted = plotSpan / Math.max(1, fitUnits);
    return scale.bandwidth > 0 ? Math.min(scale.bandwidth, fitted) : fitted;
  }
  function isResolvedCategoryScale(scale) {
    return scale?.type === "band" || scale?.type === "point";
  }

  // node_modules/@tanstack/charts/dist/dot-layout.js
  var resolveDotLayout = /* @__PURE__ */ Symbol("resolveDotLayout");

  // node_modules/@tanstack/charts/dist/resolved-layout-position.js
  function projectLayoutX(rows, values, scale) {
    return projectLayoutAxis(rows, values, scale, "xValue", "x");
  }
  function projectLayoutY(rows, values, scale) {
    return projectLayoutAxis(rows, values, scale, "yValue", "y");
  }
  function projectLayoutAxis(rows, values, scale, valueKey2, positionKey) {
    return rows.flatMap((row) => {
      const value2 = values[row.sourceIndex];
      if (!isChartValue(value2)) return [];
      const position = scale.map(value2);
      return Number.isFinite(position) ? [
        {
          ...row,
          [valueKey2]: value2,
          [positionKey]: position
        }
      ] : [];
    });
  }

  // node_modules/@tanstack/charts/dist/dot.js
  function dot(source, options = {}) {
    const data = Array.isArray(source) ? source : Array.from(source);
    const xScale = options.xScale ?? "x";
    const yScale = options.yScale ?? "y";
    return createMarkWithScaleValues(
      ({ markIndex }) => {
        const id = options.id ?? `dot-${markIndex}`;
        const layout = options.layout;
        if (layout?.axis === "x" && options.x !== void 0) {
          throw new TypeError(
            "dot: x is derived by its layout and cannot be configured"
          );
        }
        if (layout?.axis === "y" && options.y !== void 0) {
          throw new TypeError(
            "dot: y is derived by its layout and cannot be configured"
          );
        }
        const xValues = layout?.axis === "x" ? data.map(() => layout.anchor) : channelValues(data, options.x, (_datum, { index }) => index);
        const yValues = layout?.axis === "y" ? data.map(() => layout.anchor) : channelValues(
          data,
          options.y,
          (datum) => typeof datum === "number" ? datum : void 0
        );
        const zValues = channelValues(data, options.z, () => null);
        const colorValues = options.color === void 0 ? zValues : channelValues(data, options.color, () => null);
        const keys = inferredKeyValues(data, options.key, {
          groups: zValues,
          candidates: layout?.axis === "x" ? [yValues] : layout?.axis === "y" ? [xValues] : [xValues, yValues, compositeKeyValues(xValues, yValues)],
          markId: id,
          warningIdentity: options
        });
        const rawRadii = typeof options.r === "number" ? data.map(() => options.r) : channelValues(data, options.r, () => 3.5);
        const radiusMapper = resolveNumericScale(options.rScale, rawRadii);
        const radii = radiusMapper ? rawRadii.map(
          (value2) => isNonnegativeFiniteNumber(value2) ? radiusMapper(value2) : Number.NaN
        ) : rawRadii;
        const sourceRows = data.map(
          (datum, sourceIndex) => ({ datum, sourceIndex })
        );
        const renderPositions = (positions, resolveColor) => {
          const nodes = [];
          positions.forEach((position) => {
            const {
              datum,
              sourceIndex: datumIndex,
              xValue,
              yValue,
              x: x2,
              y: y2
            } = position;
            const radius = radii[datumIndex];
            if (!isNonnegativeFiniteNumber(radius)) return;
            const group2 = zValues[datumIndex] ?? null;
            const groupKey = valueKey(group2);
            const color2 = options.fill ?? resolveColor(colorValues[datumIndex] ?? null);
            const key = `${id}:${groupKey}:${valueKey(keys[datumIndex])}`;
            const point3 = {
              key,
              markId: id,
              group: group2,
              groupLabel: group2 == null ? id : String(group2),
              datum,
              datumIndex,
              xValue,
              yValue,
              x: x2,
              y: y2,
              color: color2
            };
            nodes.push({
              kind: "dot",
              key,
              x: x2,
              y: y2,
              radius,
              interaction: {
                point: point3,
                affinity: layout?.axis === "y" ? "x" : layout?.axis === "x" ? "y" : void 0
              },
              style: {
                fill: color2,
                fillOpacity: options.fillOpacity,
                stroke: options.stroke,
                strokeOpacity: options.strokeOpacity,
                strokeWidth: options.strokeWidth
              }
            });
          });
          return {
            nodes: [
              {
                kind: "group",
                key: id,
                className: "ts-chart__dot",
                ariaHidden: true,
                children: nodes
              }
            ]
          };
        };
        const channels = {
          ...layout?.axis !== "x" ? { x: { scale: xScale, values: xValues.filter(isChartValue) } } : {},
          ...layout?.axis !== "y" ? { y: { scale: yScale, values: yValues.filter(isChartValue) } } : {},
          color: {
            scale: "color",
            values: colorValues.filter(isChartKey)
          }
        };
        const initialized = {
          id,
          states: markStates(data, options.states),
          channels
        };
        if (!layout) {
          return {
            ...initialized,
            render: ({ scales, color: resolveColor }) => {
              const resolvedXScale = requiredScale(scales[xScale], xScale);
              const resolvedYScale = requiredScale(scales[yScale], yScale);
              const positions = projectLayoutY(
                projectLayoutX(sourceRows, xValues, resolvedXScale),
                yValues,
                resolvedYScale
              );
              return renderPositions(positions, resolveColor);
            }
          };
        }
        return {
          ...initialized,
          resolveLayout: ({ chart, scales }) => {
            if (layout.axis === "y") {
              const measured2 = projectLayoutX(
                sourceRows,
                xValues,
                requiredScale(scales[xScale], xScale)
              ).filter((row) => isNonnegativeFiniteNumber(radii[row.sourceIndex]));
              const crossPositions2 = resolveCrossPositions(
                layout,
                chart,
                measured2.map((row) => row.x),
                measured2.map((row) => radii[row.sourceIndex])
              );
              const positions2 = measured2.map(
                (row, index) => ({
                  ...row,
                  yValue: layout.anchor,
                  y: crossPositions2[index]
                })
              );
              return {
                render: ({ color: resolveColor }) => renderPositions(positions2, resolveColor)
              };
            }
            const measured = projectLayoutY(
              sourceRows,
              yValues,
              requiredScale(scales[yScale], yScale)
            ).filter((row) => isNonnegativeFiniteNumber(radii[row.sourceIndex]));
            const crossPositions = resolveCrossPositions(
              layout,
              chart,
              measured.map((row) => row.y),
              measured.map((row) => radii[row.sourceIndex])
            );
            const positions = measured.map(
              (row, index) => ({
                ...row,
                xValue: layout.anchor,
                x: crossPositions[index]
              })
            );
            return {
              render: ({ color: resolveColor }) => renderPositions(positions, resolveColor)
            };
          }
        };
      },
      options.motion,
      options.renderer
    );
  }
  function requiredScale(scale, id) {
    if (!scale) throw new TypeError(`dot: missing ${id} scale`);
    return scale;
  }
  function resolveCrossPositions(layout, chart, measuredPositions, radii) {
    const positions = layout[resolveDotLayout]({
      chart,
      measuredPositions,
      radii
    });
    if (positions.length !== measuredPositions.length || positions.some((position) => !Number.isFinite(position))) {
      throw new TypeError("dot: layout must resolve one finite position per row");
    }
    return positions;
  }

  // node_modules/@tanstack/charts/dist/composite-motion-internal.js
  function resolveCompositeMotion(definition2, context) {
    return typeof definition2 === "function" ? definition2(context) : definition2;
  }
  function resolveCompositeChildMotion(parent, children, context) {
    let childId;
    for (const candidate of children.keys()) {
      if ((context.markId === candidate || context.markId?.startsWith(`${candidate}:`)) && (!childId || candidate.length > childId.length)) {
        childId = candidate;
      }
    }
    return mergeCompositeMotion(
      resolveCompositeMotion(parent, context),
      childId ? resolveCompositeMotion(children.get(childId), context) : void 0
    );
  }
  function mergeCompositeMotion(parent, child) {
    if (child === false) return false;
    if (child === void 0) return parent;
    if (parent === false || parent === void 0) return child;
    const path2 = child.path ?? parent.path;
    return {
      delay: child.delay ?? parent.delay,
      ...path2 === void 0 ? {} : { path: path2 },
      transition: mergeCompositeTransition(parent.transition, child.transition)
    };
  }
  function mergeCompositeTransition(parent, child) {
    if (!parent) return child;
    if (!child) return parent;
    return parent.type === child.type ? { ...parent, ...child } : child;
  }

  // node_modules/@tanstack/charts/dist/scene-child-id-internal.js
  function sceneChildId(ownerId, childId) {
    return childId === ownerId || childId.startsWith(`${ownerId}:`) ? childId : `${ownerId}:${childId}`;
  }

  // node_modules/@tanstack/charts/dist/mark-composite-internal.js
  function composeInitializedMarks(parentId, children, options) {
    validateChildren(parentId, children, options.owner);
    const channels = mergeChildChannels(parentId, children, options);
    const scales = options.coordinates === "pixel" ? resolvedPixelScales(children) : void 0;
    const labels = children.flatMap(
      (child, childIndex) => child.layoutLabels ? [{ child, childIndex }] : []
    );
    const childMotions = new Map(
      children.flatMap(
        (child) => child.motion === void 0 ? [] : [[compositeChildMarkId(parentId, child.id), child.motion]]
      )
    );
    return {
      channels,
      ...children.some((child) => child.seriesFromColor) ? { seriesFromColor: true } : {},
      childMotions,
      ...labels.length ? {
        layoutLabels: (context) => labels.flatMap(({ child, childIndex }) => {
          const namespace = childNamespace(parentId, child.id);
          return child.layoutLabels(
            childContext(context, scales, childIndex)
          ).map((label) => namespaceLabel(label, namespace));
        })
      } : {},
      render: (context) => {
        const nodes = [];
        const points = [];
        const firstBaseMarkIndex = children.findIndex((child) => !child.focus);
        children.forEach((child, childIndex) => {
          const rendered = child.render(childContext(context, scales, childIndex));
          const childPoints = collectRenderedPoints2(rendered);
          const namespace = childNamespace(parentId, child.id);
          const namespaced = namespaceScene(
            rendered.nodes,
            childPoints,
            namespace
          );
          const interactive = options.interactiveChildren === void 0 || options.interactiveChildren.has(child.id);
          const childNodes = interactive ? namespaced.nodes : stripSceneInteractions(namespaced.nodes, namespaced.points);
          if (!interactive) {
            nodes.push(...childNodes);
            return;
          }
          if (child.focus) {
            const retarget = child.focus.retarget === true;
            nodes.push({
              kind: "group",
              key: `${namespace.prefix}:focus`,
              className: "ts-chart__focus-layer",
              ariaHidden: true,
              focus: {
                match: child.focus.match ?? "primary",
                points: namespaced.points,
                placement: firstBaseMarkIndex < 0 || childIndex < firstBaseMarkIndex ? "under" : "over",
                ...retarget ? { retarget: true, candidates: namespaced.nodes } : {}
              },
              children: retarget ? [] : childNodes
            });
            return;
          }
          if (child.states) {
            nodes.push({
              kind: "group",
              key: `${namespace.prefix}:states`,
              children: childNodes,
              states: {
                data: child.states.data,
                definitions: child.states.definitions,
                points: namespaced.points
              }
            });
          } else {
            nodes.push(...childNodes);
          }
          points.push(...namespaced.points);
        });
        return { nodes, points };
      }
    };
  }
  function initializeCompositeMark(id, marks, options = {}) {
    const children = marks.map(
      (mark, childIndex) => mark.initialize({ markIndex: childIndex })
    );
    const composition = composeInitializedMarks(id, children, {
      coordinates: "semantic",
      owner: "Composite mark",
      interactiveChildren: options.interactiveChildren
    });
    const motion = options.motion !== void 0 || composition.childMotions.size > 0 ? (context) => resolveCompositeChildMotion(
      options.motion,
      composition.childMotions,
      context
    ) : void 0;
    return {
      id,
      channels: composition.channels,
      ...composition.seriesFromColor ? { seriesFromColor: true } : {},
      ...composition.layoutLabels ? { layoutLabels: composition.layoutLabels } : {},
      ...motion ? { motion } : {},
      render: composition.render
    };
  }
  function validateChildren(parentId, children, owner) {
    const childIds = /* @__PURE__ */ new Set();
    const resolvedIds = /* @__PURE__ */ new Map();
    for (const child of children) {
      if (child.postDomain) {
        throw new TypeError(
          `${owner} cannot compose child mark "${child.id}" because it has post-domain filtering; wrap the composed mark instead`
        );
      }
      if (child.resolveLayout) {
        throw new TypeError(
          `${owner} cannot compose child mark "${child.id}" because it has its own layout`
        );
      }
      if (childIds.has(child.id)) {
        throw new TypeError(
          `${owner} cannot compose duplicate child mark id "${child.id}"`
        );
      }
      childIds.add(child.id);
      const resolvedId = compositeChildMarkId(parentId, child.id);
      const previousId = resolvedIds.get(resolvedId);
      if (previousId !== void 0) {
        throw new TypeError(
          `${owner} cannot compose child mark ids "${previousId}" and "${child.id}" because both resolve to namespace "${resolvedId}"`
        );
      }
      resolvedIds.set(resolvedId, child.id);
    }
  }
  function mergeChildChannels(parentId, children, options) {
    const merged = {};
    for (const child of children) {
      for (const [name, channel] of Object.entries(child.channels)) {
        if (options.coordinates === "pixel" && (channel.scale === "x" || channel.scale === "y")) {
          validatePixelChannel(child.id, name, channel.scale, channel.values);
          continue;
        }
        merged[`${compositeChildMarkId(parentId, child.id)}:${name}`] = preserveMaterializedPositionChannel(name, channel);
      }
    }
    return merged;
  }
  function validatePixelChannel(markId, channelName, axis, values) {
    values.forEach((value2, index) => {
      if (typeof value2 === "number" && Number.isFinite(value2)) return;
      throw new TypeError(
        `Resolved child mark "${markId}" ${axis} channel "${channelName}" requires finite pixel numbers; received ${String(value2)} at index ${index}`
      );
    });
  }
  function resolvedPixelScales(children) {
    const values = { x: [], y: [] };
    for (const child of children) {
      for (const channel of Object.values(child.channels)) {
        if (channel.scale !== "x" && channel.scale !== "y") continue;
        values[channel.scale].push(...channel.values);
      }
    }
    return {
      x: pixelScale("x", values.x),
      y: pixelScale("y", values.y)
    };
  }
  function pixelScale(axis, values) {
    const finitePixel = (value2) => {
      if (typeof value2 === "number" && Number.isFinite(value2)) return value2;
      throw new TypeError(
        `Resolved child ${axis} scale requires a finite pixel number; received ${String(value2)}`
      );
    };
    return {
      id: axis,
      type: "identity",
      domain: [...new Set(values)],
      map: finitePixel,
      invert: finitePixel,
      ticks: [],
      bandwidth: 0
    };
  }
  function childContext(context, scales, markIndex) {
    return {
      ...context,
      markIndex,
      ...scales ? { scales: { ...context.scales, ...scales } } : {}
    };
  }
  function childNamespace(parentId, childId) {
    const prefix = compositeChildMarkId(parentId, childId);
    return {
      prefix,
      identity: (value2) => {
        if (value2 === childId) return prefix;
        if (value2.startsWith(`${childId}:`)) {
          return `${prefix}${value2.slice(childId.length)}`;
        }
        if (value2 === prefix || value2.startsWith(`${prefix}:`)) return value2;
        return `${prefix}:${value2}`;
      }
    };
  }
  function compositeChildMarkId(parentId, childId) {
    return sceneChildId(parentId, childId);
  }
  function namespaceLabel(label, namespace) {
    return { ...label, key: namespace.identity(label.key) };
  }
  function namespaceScene(nodes, points, namespace) {
    const mappedPoints = /* @__PURE__ */ new Map();
    const mapPoint = (point3) => {
      const previous = mappedPoints.get(point3);
      if (previous) return previous;
      const mapped = {
        ...point3,
        key: namespace.identity(point3.key),
        markId: namespace.identity(point3.markId)
      };
      mappedPoints.set(point3, mapped);
      return mapped;
    };
    return {
      nodes: mapSceneNodes(nodes, namespace, mapPoint),
      points: points.map(mapPoint)
    };
  }
  function stripSceneInteractions(nodes, points, lookup = createScenePointLookup(points)) {
    return nodes.map((node) => {
      if (node.kind === "group") {
        const { focus: _focus, states: _states, ...decorative2 } = node;
        const owned2 = sceneNodeOwnedPoints(node, points, lookup, []);
        return {
          ...decorative2,
          children: stripSceneInteractions(
            node.children,
            owned2.length ? owned2 : points,
            lookup
          )
        };
      }
      if (node.kind === "label") return node;
      const { interaction: _interaction, ...decorative } = node;
      const owned = node.interaction?.point ? [node.interaction.point] : node.interaction?.points ?? sceneNodeOwnedPoints(node, points, lookup, []);
      return owned.length === 1 ? { ...decorative, pointOwner: owned[0] } : decorative;
    });
  }
  function mapSceneNodes(nodes, namespace, mapPoint) {
    return nodes.map((node) => {
      const key = namespace.identity(node.key);
      if (node.kind === "group") {
        return {
          ...node,
          key,
          ...node.pointOwner ? { pointOwner: mapPoint(node.pointOwner) } : {},
          children: mapSceneNodes(node.children, namespace, mapPoint),
          ...node.focus ? {
            focus: {
              ...node.focus,
              points: node.focus.points.map(mapPoint),
              ...node.focus.candidates ? {
                candidates: mapSceneNodes(
                  node.focus.candidates,
                  namespace,
                  mapPoint
                )
              } : {},
              ...node.focus.activePoints ? { activePoints: node.focus.activePoints.map(mapPoint) } : {}
            }
          } : {},
          ...node.states ? {
            states: {
              ...node.states,
              points: node.states.points.map(mapPoint)
            }
          } : {}
        };
      }
      if (node.kind === "label" || !node.interaction) {
        return {
          ...node,
          key,
          ...node.pointOwner ? { pointOwner: mapPoint(node.pointOwner) } : {}
        };
      }
      return {
        ...node,
        key,
        ...node.pointOwner ? { pointOwner: mapPoint(node.pointOwner) } : {},
        interaction: node.interaction.point ? { ...node.interaction, point: mapPoint(node.interaction.point) } : {
          ...node.interaction,
          points: node.interaction.points.map(mapPoint)
        }
      };
    });
  }
  function collectRenderedPoints2(scene) {
    const points = scene.points ? [...scene.points] : [];
    const seen = new Set(points);
    const visit = (nodes) => {
      for (const node of nodes) {
        if (node.kind === "group") {
          if (!node.focus) visit(node.children);
          continue;
        }
        if (node.kind === "label" || !node.interaction) continue;
        const interaction = node.interaction;
        const candidates = interaction.point ? [interaction.point] : interaction.points;
        for (const point3 of candidates) {
          if (seen.has(point3)) continue;
          seen.add(point3);
          points.push(point3);
        }
      }
    };
    visit(scene.nodes);
    return points;
  }

  // node_modules/@tanstack/charts/dist/link.js
  function link(source, options) {
    const data = Array.isArray(source) ? source : Array.from(source);
    const xScale = options.xScale ?? "x";
    const yScale = options.yScale ?? "y";
    return createMark(
      ({ markIndex }) => {
        const id = options.id ?? `link-${markIndex}`;
        const x1Values = channelValues(data, options.x1, () => void 0);
        const y1Values = channelValues(data, options.y1, () => void 0);
        const x2Values = channelValues(data, options.x2, () => void 0);
        const y2Values = channelValues(data, options.y2, () => void 0);
        const zValues = channelValues(data, options.z, () => null);
        const colorValues = options.color === void 0 ? zValues : channelValues(data, options.color, () => null);
        const keys = inferredKeyValues(data, options.key, { groups: zValues });
        return {
          id,
          channels: {
            x: {
              scale: xScale,
              values: [...x1Values, ...x2Values].filter(isChartValue)
            },
            y: {
              scale: yScale,
              values: [...y1Values, ...y2Values].filter(isChartValue)
            },
            color: {
              scale: "color",
              values: colorValues.filter(isChartKey)
            }
          },
          render: ({ scales, color: resolveColor }) => {
            const nodes = [];
            const points = [];
            data.forEach((datum, datumIndex) => {
              const x1Value = x1Values[datumIndex];
              const y1Value = y1Values[datumIndex];
              const x2Value = x2Values[datumIndex];
              const y2Value = y2Values[datumIndex];
              if (!isChartValue(x1Value) || !isChartValue(y1Value) || !isChartValue(x2Value) || !isChartValue(y2Value)) {
                return;
              }
              const x1 = scales[xScale].map(x1Value);
              const y1 = scales[yScale].map(y1Value);
              const x2 = scales[xScale].map(x2Value);
              const y2 = scales[yScale].map(y2Value);
              const group2 = zValues[datumIndex] ?? null;
              const color2 = visualValue(
                options.stroke,
                datum,
                datumIndex,
                data,
                resolveColor(colorValues[datumIndex] ?? null)
              );
              const key = `${id}:${valueKey(group2)}:${valueKey(keys[datumIndex])}`;
              const style = {
                fill: "none",
                stroke: color2,
                strokeOpacity: options.strokeOpacity === void 0 ? void 0 : visualValue(
                  options.strokeOpacity,
                  datum,
                  datumIndex,
                  data,
                  1
                ),
                strokeWidth: visualValue(
                  options.strokeWidth,
                  datum,
                  datumIndex,
                  data,
                  1.5
                ),
                strokeDasharray: options.strokeDasharray,
                lineCap: options.lineCap ?? "round",
                lineJoin: "round"
              };
              nodes.push(
                options.curve ? {
                  kind: "polyline",
                  key,
                  points: [
                    [x1, y1],
                    [x2, y2]
                  ],
                  path: options.curve.line([
                    [x1, y1],
                    [x2, y2]
                  ]),
                  style
                } : {
                  kind: "rule",
                  key,
                  x1,
                  y1,
                  x2,
                  y2,
                  style
                }
              );
              points.push({
                key,
                markId: id,
                group: group2,
                groupLabel: group2 == null ? id : String(group2),
                datum,
                datumIndex,
                xValue: x2Value,
                yValue: y2Value,
                x1Value,
                x2Value,
                y1Value,
                y2Value,
                xInterval: "range",
                yInterval: "range",
                x: (x1 + x2) / 2,
                y: (y1 + y2) / 2,
                color: color2
              });
            });
            return {
              nodes: [
                {
                  kind: "group",
                  key: id,
                  className: "ts-chart__link",
                  ariaHidden: true,
                  children: nodes
                }
              ],
              points
            };
          }
        };
      },
      options.motion,
      options.renderer
    );
  }

  // node_modules/@tanstack/charts/dist/tick.js
  function tickX(source, options) {
    return tick(source, options, "x");
  }
  function tickY(source, options) {
    return tick(source, options, "y");
  }
  function tick(source, options, orientation) {
    const data = Array.isArray(source) ? source : Array.from(source);
    const xScale = options.xScale ?? "x";
    const yScale = options.yScale ?? "y";
    if (options.length !== void 0 && options.span !== void 0) {
      throw new TypeError("tick: length and span are mutually exclusive");
    }
    if (options.span !== void 0 && (!isFiniteNumber(options.span) || options.span <= 0)) {
      throw new TypeError("tick: span must be a positive finite number");
    }
    return createMark(
      ({ markIndex }) => {
        const id = options.id ?? `tick-${orientation}-${markIndex}`;
        const xValues = channelValues(data, options.x, () => void 0);
        const yValues = channelValues(data, options.y, () => void 0);
        const zValues = channelValues(data, options.z, () => null);
        const colorValues = options.color === void 0 ? zValues : channelValues(data, options.color, () => null);
        const keys = inferredKeyValues(data, options.key, { groups: zValues });
        return {
          id,
          channels: {
            x: { scale: xScale, values: xValues.filter(isChartValue) },
            y: { scale: yScale, values: yValues.filter(isChartValue) },
            color: {
              scale: "color",
              values: colorValues.filter(isChartKey)
            }
          },
          render: ({ chart, scales, color: resolveColor }) => {
            const nodes = [];
            const points = [];
            const orthogonalScale = orientation === "x" ? scales[yScale] : scales[xScale];
            const bandwidth = orthogonalScale.bandwidth;
            if (options.span !== void 0 && !isResolvedCategoryScale(orthogonalScale)) {
              throw new TypeError(
                `tick${orientation.toUpperCase()}: span requires a point or band scale on the orthogonal axis`
              );
            }
            const spanLength = options.span === void 0 ? void 0 : resolvedCategoryStep(
              orthogonalScale,
              orientation === "x" ? chart.height : chart.width,
              options.span
            ) * options.span;
            const availableLength = Math.max(
              0,
              (spanLength ?? options.length ?? (bandwidth || 6)) - (options.inset ?? 0) * 2
            );
            data.forEach((datum, datumIndex) => {
              const xValue = xValues[datumIndex];
              const yValue = yValues[datumIndex];
              if (!isChartValue(xValue) || !isChartValue(yValue)) return;
              const x2 = scales[xScale].map(xValue);
              const y2 = scales[yScale].map(yValue);
              const group2 = zValues[datumIndex] ?? null;
              const color2 = visualValue(
                options.stroke,
                datum,
                datumIndex,
                data,
                resolveColor(colorValues[datumIndex] ?? null)
              );
              const key = `${id}:${valueKey(group2)}:${valueKey(keys[datumIndex])}`;
              nodes.push({
                kind: "rule",
                key,
                x1: orientation === "x" ? x2 : x2 - availableLength / 2,
                x2: orientation === "x" ? x2 : x2 + availableLength / 2,
                y1: orientation === "x" ? y2 - availableLength / 2 : y2,
                y2: orientation === "x" ? y2 + availableLength / 2 : y2,
                style: {
                  stroke: color2,
                  strokeOpacity: options.strokeOpacity,
                  strokeWidth: options.strokeWidth ?? 1.5,
                  lineCap: "butt"
                }
              });
              points.push({
                key,
                markId: id,
                group: group2,
                groupLabel: group2 == null ? id : String(group2),
                datum,
                datumIndex,
                xValue,
                yValue,
                x: x2,
                y: y2,
                color: color2
              });
            });
            return {
              nodes: [
                {
                  kind: "group",
                  key: id,
                  className: `ts-chart__tick ts-chart__tick-${orientation}`,
                  ariaHidden: true,
                  children: nodes
                }
              ],
              points
            };
          }
        };
      },
      options.motion,
      options.renderer
    );
  }

  // node_modules/@tanstack/charts/dist/transform-internal.js
  function toArray(source) {
    return Array.isArray(source) ? source : Array.from(source);
  }
  function transformValues(data, value2) {
    if (typeof value2 === "function") {
      const accessor = value2;
      return data.map((datum, index) => accessor(datum, { index, data }));
    }
    return data.map(
      (datum) => datum != null && typeof datum === "object" ? datum[value2] : void 0
    );
  }
  function transformKey(value2) {
    if (Array.isArray(value2)) {
      return `tuple:${JSON.stringify(value2.map((entry) => transformKey(entry)))}`;
    }
    if (value2 instanceof Date) return `date:${value2.getTime()}`;
    return `${typeof value2}:${String(value2)}`;
  }
  function groupedIndexes(keys) {
    const groups = /* @__PURE__ */ new Map();
    keys.forEach((key, index) => {
      const identity = transformKey(key);
      const group2 = groups.get(identity);
      if (group2) group2.indexes.push(index);
      else groups.set(identity, { key, indexes: [index] });
    });
    return [...groups.values()];
  }
  function orderedIndexes(data, indexes, orderBy, order = "ascending") {
    if (orderBy === void 0) return [...indexes];
    const values = transformValues(data, orderBy);
    const direction = order === "descending" ? -1 : 1;
    return [...indexes].sort((left2, right2) => {
      const a = values[left2];
      const b = values[right2];
      const compared = compareChartValues(a, b);
      return compared === 0 ? left2 - right2 : compared * direction;
    });
  }
  function compareChartValues(left2, right2) {
    const a = left2 instanceof Date ? left2.getTime() : left2;
    const b = right2 instanceof Date ? right2.getTime() : right2;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  // node_modules/@tanstack/charts/dist/transform-statistics-internal.js
  function quantileSortedValues(values, probability) {
    if (!values.length) return Number.NaN;
    const position = (values.length - 1) * probability;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const start = values[lower];
    const end = values[upper];
    return start + (end - start) * (position - lower);
  }

  // node_modules/@tanstack/charts/dist/box.js
  function boxRows(source, options) {
    const data = toArray(source);
    const { summaries, outliers } = summarizeBoxes(
      data,
      transformValues(data, options.category),
      transformValues(data, options.value)
    );
    return [...summaries, ...outliers];
  }
  function boxY(source, options) {
    return box(source, options, options.x, options.y, "y");
  }
  var interactiveBoxChildren = /* @__PURE__ */ new Set(["box", "outlier"]);
  function box(source, options, category, numeric, orientation) {
    const data = Array.isArray(source) ? source : Array.from(source);
    const xScale = options.xScale ?? "x";
    const yScale = options.yScale ?? "y";
    return createMark(
      ({ markIndex }) => {
        const id = options.id ?? `box-${orientation}-${markIndex}`;
        const categoryValues = channelValues(data, category, () => void 0);
        const numericValues = channelValues(data, numeric, () => void 0);
        const keys = inferredKeyValues(data, options.key, {
          groups: categoryValues,
          markId: id,
          warningIdentity: options
        });
        const rows = boxRows(data, {
          category: (_datum, { index }) => categoryValues[index],
          value: (_datum, { index }) => numericValues[index]
        });
        const summaries = rows.flatMap(
          (row) => row.kind === "summary" ? [{ ...row, markKey: `box:${valueKey(row.category)}` }] : []
        );
        const outliers = rows.flatMap((row) => {
          if (row.kind !== "outlier") return [];
          const sourceIndex = row.sourceIndexes[0];
          return [
            {
              ...row,
              markKey: `box:${valueKey(row.category)}:outlier:${valueKey(
                keys[sourceIndex]
              )}`
            }
          ];
        });
        const stroke = options.stroke ?? "currentColor";
        const children = orientation === "y" ? [
          link(summaries, {
            id: "whisker",
            x1: "category",
            y1: "whiskerLow",
            x2: "category",
            y2: "whiskerHigh",
            key: "markKey",
            stroke,
            strokeOpacity: options.strokeOpacity,
            strokeWidth: options.strokeWidth ?? 1,
            lineCap: "butt",
            xScale,
            yScale
          }),
          barY(summaries, {
            id: "box",
            x: "category",
            y: "median",
            y1: "q1",
            y2: "q3",
            key: "markKey",
            fill: options.fill ?? "#ccc",
            fillOpacity: options.fillOpacity,
            inset: options.inset,
            xScale,
            yScale
          }),
          tickY(summaries, {
            id: "median",
            x: "category",
            y: "median",
            key: "markKey",
            stroke,
            strokeOpacity: options.strokeOpacity,
            strokeWidth: options.strokeWidth ?? 2,
            inset: options.inset,
            xScale,
            yScale
          }),
          dot(outliers, {
            id: "outlier",
            x: "category",
            y: "value",
            key: "markKey",
            r: options.r ?? 3,
            fill: "none",
            stroke,
            strokeOpacity: options.strokeOpacity,
            strokeWidth: options.strokeWidth ?? 1.5,
            xScale,
            yScale
          })
        ] : [
          link(summaries, {
            id: "whisker",
            x1: "whiskerLow",
            y1: "category",
            x2: "whiskerHigh",
            y2: "category",
            key: "markKey",
            stroke,
            strokeOpacity: options.strokeOpacity,
            strokeWidth: options.strokeWidth ?? 1,
            lineCap: "butt",
            xScale,
            yScale
          }),
          barX(summaries, {
            id: "box",
            x: "median",
            x1: "q1",
            x2: "q3",
            y: "category",
            key: "markKey",
            fill: options.fill ?? "#ccc",
            fillOpacity: options.fillOpacity,
            inset: options.inset,
            xScale,
            yScale
          }),
          tickX(summaries, {
            id: "median",
            x: "median",
            y: "category",
            key: "markKey",
            stroke,
            strokeOpacity: options.strokeOpacity,
            strokeWidth: options.strokeWidth ?? 2,
            inset: options.inset,
            xScale,
            yScale
          }),
          dot(outliers, {
            id: "outlier",
            x: "value",
            y: "category",
            key: "markKey",
            r: options.r ?? 3,
            fill: "none",
            stroke,
            strokeOpacity: options.strokeOpacity,
            strokeWidth: options.strokeWidth ?? 1.5,
            xScale,
            yScale
          })
        ];
        return initializeCompositeMark(id, children, {
          motion: options.motion,
          interactiveChildren: interactiveBoxChildren
        });
      },
      options.motion,
      options.renderer
    );
  }
  function summarizeBoxes(data, categoryValues, numericValues) {
    const summaries = [];
    const outliers = [];
    for (const { key: category, indexes } of groupedIndexes(categoryValues)) {
      if (!isChartValue(category)) continue;
      const observations = indexes.flatMap((sourceIndex) => {
        const value2 = numericValues[sourceIndex];
        return typeof value2 === "number" && Number.isFinite(value2) ? [{ sourceIndex, value: value2 }] : [];
      });
      if (!observations.length) continue;
      const sourceIndexes = observations.map(({ sourceIndex }) => sourceIndex);
      const ranked = [...observations].sort(
        (left2, right2) => left2.value - right2.value || left2.sourceIndex - right2.sourceIndex
      );
      const values = ranked.map(({ value: value2 }) => value2);
      const q1 = quantileSortedValues(values, 0.25);
      const median = quantileSortedValues(values, 0.5);
      const q3 = quantileSortedValues(values, 0.75);
      const spread = q3 - q1;
      const lowerFence = q1 - spread * 1.5;
      const upperFence = q3 + spread * 1.5;
      const whiskerLow = ranked.find(({ value: value2 }) => value2 >= lowerFence)?.value ?? q1;
      let whiskerHigh = q3;
      for (let index = ranked.length - 1; index >= 0; index -= 1) {
        const candidate = ranked[index];
        if (!candidate || candidate.value > upperFence) continue;
        whiskerHigh = candidate.value;
        break;
      }
      summaries.push({
        kind: "summary",
        category,
        q1,
        median,
        q3,
        whiskerLow,
        whiskerHigh,
        count: sourceIndexes.length,
        source: sourceIndexes.map((index) => data[index]),
        sourceIndexes
      });
      for (const { sourceIndex, value: value2 } of observations) {
        if (value2 >= lowerFence && value2 <= upperFence) continue;
        outliers.push({
          kind: "outlier",
          category,
          value: value2,
          source: [data[sourceIndex]],
          sourceIndexes: [sourceIndex]
        });
      }
    }
    outliers.sort((left2, right2) => left2.sourceIndexes[0] - right2.sourceIndexes[0]);
    return { summaries, outliers };
  }

  // node_modules/@tanstack/charts/dist/d3-shape.js
  function d3Curve(curve) {
    const linePath = line_default().x((point3) => point3[0]).y((point3) => point3[1]).curve(curve);
    const areaPath = area_default().x((point3) => point3[0]).y0((point3) => point3[1]).y1((point3) => point3[2]).curve(curve);
    return {
      line: (points) => linePath(points) ?? "",
      area: (top, bottom) => areaPath(
        top.map(
          (point3, index) => [point3[0], bottom[index]?.[1] ?? point3[1], point3[1]]
        )
      ) ?? ""
    };
  }

  // node_modules/@tanstack/charts/dist/line.js
  function lineY(source, options = {}) {
    const data = Array.isArray(source) ? source : Array.from(source);
    return createLineMark(data, options, "line", () => {
      const xValues = channelValues(data, options.x, (_datum, { index }) => index);
      const yValues = channelValues(
        data,
        options.y,
        (datum) => typeof datum === "number" ? datum : void 0
      );
      return {
        xValues,
        yValues,
        isValidX: isChartValue,
        isValidY: isFiniteNumber,
        keyValues: xValues,
        affinity: "x"
      };
    });
  }
  function createLineMark(data, options, idPrefix, channels) {
    const xScale = options.xScale ?? "x";
    const yScale = options.yScale ?? "y";
    return createMark(
      ({ markIndex }) => {
        const id = options.id ?? `${idPrefix}-${markIndex}`;
        const { xValues, yValues, isValidX, isValidY, keyValues, affinity } = channels();
        const zValues = channelValues(data, options.z, () => null);
        const colorValues = options.color === void 0 ? zValues : channelValues(data, options.color, () => null);
        const groupValues = options.z === void 0 && options.color !== void 0 ? colorValues : zValues;
        const keys = inferredKeyValues(data, options.key, {
          groups: groupValues,
          candidates: [keyValues],
          markId: id,
          warningIdentity: options
        });
        const rows = data.map((datum, datumIndex) => ({
          datum,
          datumIndex,
          xValue: xValues[datumIndex],
          yValue: yValues[datumIndex],
          groupValue: groupValues[datumIndex],
          datumKey: keys[datumIndex]
        }));
        return {
          id,
          states: markStates(data, options.states),
          seriesFromColor: options.z === void 0 && options.color !== void 0,
          channels: {
            x: {
              scale: xScale,
              values: xValues.filter(isValidX)
            },
            y: {
              scale: yScale,
              values: yValues.filter(isValidY)
            },
            color: {
              scale: "color",
              values: colorValues.filter(isChartKey)
            }
          },
          render: ({ scales, color: resolveColor }) => {
            const groups = groupRows(rows);
            const nodes = [];
            for (const [groupKey, groupRows2] of groups) {
              const firstRow = groupRows2[0];
              if (!firstRow) continue;
              const color2 = visualValue(
                options.stroke,
                firstRow.datum,
                firstRow.datumIndex,
                data,
                resolveColor(colorValues[firstRow.datumIndex] ?? null)
              );
              const children = [];
              let segment = [];
              let segmentPoints = [];
              let segmentIndex = 0;
              const flushSegment = () => {
                if (!segment.length) return;
                children.push({
                  kind: "polyline",
                  key: `${id}:${groupKey}:segment:${segmentIndex}`,
                  points: segment,
                  path: options.curve?.line(segment),
                  interaction: {
                    points: segmentPoints,
                    affinity
                  },
                  style: {
                    fill: "none",
                    stroke: color2,
                    strokeOpacity: options.strokeOpacity,
                    strokeWidth: options.strokeWidth ?? 2.25,
                    strokeDasharray: options.strokeDasharray,
                    lineCap: "round",
                    lineJoin: "round"
                  }
                });
                segment = [];
                segmentPoints = [];
                segmentIndex += 1;
              };
              for (const row of groupRows2) {
                if (!isValidX(row.xValue) || !isValidY(row.yValue)) {
                  flushSegment();
                  continue;
                }
                const x2 = scales[xScale].map(row.xValue);
                const y2 = scales[yScale].map(row.yValue);
                const point3 = {
                  key: `${id}:${groupKey}:${valueKey(row.datumKey)}`,
                  markId: id,
                  group: row.groupValue ?? null,
                  groupLabel: row.groupValue == null ? id : String(row.groupValue),
                  datum: row.datum,
                  datumIndex: row.datumIndex,
                  xValue: row.xValue,
                  yValue: row.yValue,
                  x: x2,
                  y: y2,
                  color: color2
                };
                segmentPoints.push(point3);
                segment.push([x2, y2]);
                if (options.points) {
                  children.push({
                    kind: "dot",
                    key: `${point3.key}:dot`,
                    x: x2,
                    y: y2,
                    radius: 2.5,
                    pointOwner: point3,
                    style: { fill: color2 }
                  });
                }
              }
              flushSegment();
              nodes.push({
                kind: "group",
                key: `${id}:${groupKey}`,
                className: "ts-chart__line",
                ariaHidden: true,
                children
              });
            }
            return { nodes };
          }
        };
      },
      options.motion,
      options.renderer
    );
  }
  function groupRows(rows) {
    const groups = /* @__PURE__ */ new Map();
    for (const row of rows) {
      const key = valueKey(row.groupValue ?? null);
      const group2 = groups.get(key);
      if (group2) group2.push(row);
      else groups.set(key, [row]);
    }
    return groups;
  }

  // node_modules/@tanstack/charts/dist/resolved-layout-child.js
  function composeResolvedChildMarks(parentId, children) {
    const composition = composeInitializedMarks(parentId, children, {
      coordinates: "pixel",
      owner: "Resolved layout"
    });
    return {
      channels: composition.channels,
      layoutLabels: composition.layoutLabels,
      render: composition.render
    };
  }
  var resolvedChildMarkId = compositeChildMarkId;

  // node_modules/@tanstack/charts/dist/group.js
  function group(options = {}) {
    return { type: "group", ...options };
  }

  // node_modules/@tanstack/charts/dist/legend-layout-internal.js
  function resolveCategoricalLegendItems(colors, format2 = String) {
    return colors.domain.map((value2) => ({
      key: valueKey(value2),
      value: value2,
      label: format2(value2),
      color: colors.map(value2)
    }));
  }
  function layoutCategoricalLegendItems(itemCount, width, minimumItemWidth) {
    const columns = Math.max(
      1,
      Math.min(itemCount || 1, Math.floor(width / minimumItemWidth) || 1)
    );
    return {
      columns,
      rows: Math.ceil(itemCount / columns),
      itemWidth: width / columns
    };
  }

  // node_modules/@tanstack/charts/dist/legend-static.js
  function colorLegend(options = {}) {
    const gradient = colorGradientLegend({
      label: options.label,
      width: options.width,
      format: options.format,
      placement: options.placement
    });
    const minimumItemWidth = Math.max(64, options.itemWidth ?? 110);
    const labelOffset = options.label ? 13 : 0;
    return {
      placement: options.placement,
      height(itemCount, context) {
        if (isQuantitativeLegend(context.colors.kind)) {
          return gradient.height(itemCount, context);
        }
        const layout = layoutCategoricalLegendItems(
          itemCount,
          context.chart.width,
          minimumItemWidth
        );
        return 18 + labelOffset + layout.rows * 19;
      },
      render(context) {
        if (isContinuousLegend(context.colors.kind)) {
          return gradient.render(context);
        }
        if (isSteppedLegend(context.colors.kind)) {
          return renderSteppedLegend(options, context);
        }
        const { colors, bounds, theme } = context;
        const items = resolveCategoricalLegendItems(colors);
        const layout = layoutCategoricalLegendItems(
          items.length,
          bounds.width,
          minimumItemWidth
        );
        const children = [];
        if (options.label) {
          children.push({
            kind: "label",
            key: "legend-label",
            x: bounds.x,
            y: bounds.y + 11,
            text: options.label,
            fontSize: 11,
            fontWeight: 600,
            style: { fill: theme.foreground, fillOpacity: 0.78 }
          });
        }
        items.forEach((item, index) => {
          const column = index % layout.columns;
          const row = Math.floor(index / layout.columns);
          const x2 = bounds.x + column * layout.itemWidth;
          const y2 = bounds.y + 10 + labelOffset + row * 19;
          children.push(
            {
              kind: "dot",
              key: `legend-dot:${item.key}`,
              x: x2 + 4,
              y: y2,
              radius: 4,
              style: { fill: item.color }
            },
            {
              kind: "label",
              key: `legend-label:${item.key}`,
              x: x2 + 13,
              y: y2,
              text: item.label,
              baseline: "middle",
              fontSize: 11,
              style: { fill: theme.foreground, fillOpacity: 0.76 }
            }
          );
        });
        return {
          kind: "group",
          key: "legend",
          className: "ts-chart__legend",
          ariaHidden: true,
          children
        };
      }
    };
  }
  function isContinuousLegend(kind) {
    return kind === "continuous";
  }
  function isSteppedLegend(kind) {
    return kind === "quantile" || kind === "quantize" || kind === "threshold";
  }
  function isQuantitativeLegend(kind) {
    return isContinuousLegend(kind) || isSteppedLegend(kind);
  }
  function renderSteppedLegend(options, { colors, bounds, theme }) {
    const width = Math.min(bounds.width, Math.max(80, options.width ?? 240));
    const x2 = bounds.x;
    const y2 = bounds.y + (options.label ? 20 : 7);
    const itemWidth = width / Math.max(1, colors.range.length);
    const format2 = options.format ?? ((value2) => String(value2));
    const children = [];
    if (options.label) {
      children.push({
        kind: "label",
        key: "legend-label",
        x: x2,
        y: bounds.y + 10,
        text: options.label,
        fontSize: 11,
        fontWeight: 600,
        style: { fill: theme.foreground, fillOpacity: 0.78 }
      });
    }
    colors.range.forEach((fill, index) => {
      children.push({
        kind: "rect",
        key: `legend-step:${index}`,
        x: x2 + index * itemWidth,
        y: y2,
        width: itemWidth + 0.5,
        height: 8,
        style: { fill }
      });
    });
    const thresholds = legendThresholds(colors);
    const first = colors.domain[0];
    const last = colors.domain.at(-1);
    const boundaries = colors.kind === "threshold" ? thresholds.map((value2, index) => ({
      value: value2,
      index: index + 1,
      anchor: "middle"
    })) : [
      ...typeof first === "number" ? [{ value: first, index: 0, anchor: "start" }] : [],
      ...thresholds.map((value2, index) => ({
        value: value2,
        index: index + 1,
        anchor: "middle"
      })),
      ...typeof last === "number" ? [
        {
          value: last,
          index: colors.range.length,
          anchor: "end"
        }
      ] : []
    ];
    boundaries.forEach(({ value: value2, index, anchor }) => {
      children.push({
        kind: "label",
        key: `legend-step-label:${index}:${value2}`,
        x: x2 + index * itemWidth,
        y: y2 + 21,
        text: format2(value2),
        anchor,
        fontSize: 10,
        style: { fill: theme.muted, fillOpacity: 0.72 }
      });
    });
    return {
      kind: "group",
      key: "legend",
      className: "ts-chart__legend ts-chart__legend--stepped",
      ariaHidden: true,
      children
    };
  }
  function legendThresholds(colors) {
    if (colors.thresholds) {
      return colors.thresholds.filter(Number.isFinite);
    }
    const numericDomain = colors.domain.filter(
      (value2) => typeof value2 === "number" && Number.isFinite(value2)
    );
    if (colors.kind === "threshold") return numericDomain;
    const domain = numericDomain.slice().sort((left2, right2) => left2 - right2);
    const first = domain[0];
    const last = domain.at(-1);
    if (first === void 0 || last === void 0) return [];
    const count2 = colors.range.length;
    if (colors.kind === "quantize") {
      return Array.from(
        { length: Math.max(0, count2 - 1) },
        (_value, index) => first + (last - first) * (index + 1) / count2
      );
    }
    if (colors.kind === "quantile") {
      return Array.from(
        { length: Math.max(0, count2 - 1) },
        (_value, index) => quantileSorted(domain, (index + 1) / count2)
      ).filter(Number.isFinite);
    }
    return [];
  }
  function quantileSorted(values, probability) {
    const count2 = values.length;
    if (count2 === 0) return Number.NaN;
    if (probability <= 0 || count2 < 2) return values[0] ?? Number.NaN;
    if (probability >= 1) return values[count2 - 1] ?? Number.NaN;
    const position = (count2 - 1) * probability;
    const lowerIndex = Math.floor(position);
    const lower = values[lowerIndex] ?? Number.NaN;
    const upper = values[lowerIndex + 1] ?? lower;
    return lower + (upper - lower) * (position - lowerIndex);
  }
  function colorGradientLegend(options = {}) {
    return {
      placement: options.placement,
      height() {
        return options.label ? 55 : 42;
      },
      render({ colors, bounds, theme }) {
        const first = colors.domain[0];
        const last = colors.domain.at(-1);
        if (typeof first !== "number" || typeof last !== "number") {
          throw new TypeError(
            "A gradient legend requires a numeric color-scale domain"
          );
        }
        const steps = Math.max(2, Math.floor(options.steps ?? 32));
        const width = Math.min(bounds.width, Math.max(80, options.width ?? 240));
        const x2 = bounds.x;
        const y2 = bounds.y + (options.label ? 20 : 7);
        const itemWidth = width / steps;
        const format2 = options.format ?? ((value2) => String(value2));
        const children = [];
        if (options.label) {
          children.push({
            kind: "label",
            key: "legend-label",
            x: x2,
            y: bounds.y + 10,
            text: options.label,
            fontSize: 11,
            fontWeight: 600,
            style: { fill: theme.foreground, fillOpacity: 0.78 }
          });
        }
        for (let index = 0; index < steps; index += 1) {
          const ratio = index / (steps - 1);
          const value2 = first + (last - first) * ratio;
          children.push({
            kind: "rect",
            key: `legend-gradient:${index}`,
            x: x2 + index * itemWidth,
            y: y2,
            width: itemWidth + 0.5,
            height: 8,
            style: { fill: colors.map(value2) }
          });
        }
        children.push(
          {
            kind: "label",
            key: "legend-gradient:min",
            x: x2,
            y: y2 + 21,
            text: format2(first),
            anchor: "start",
            fontSize: 10,
            style: { fill: theme.muted, fillOpacity: 0.72 }
          },
          {
            kind: "label",
            key: "legend-gradient:max",
            x: x2 + width,
            y: y2 + 21,
            text: format2(last),
            anchor: "end",
            fontSize: 10,
            style: { fill: theme.muted, fillOpacity: 0.72 }
          }
        );
        return {
          kind: "group",
          key: "legend",
          className: "ts-chart__legend ts-chart__legend--gradient",
          ariaHidden: true,
          children
        };
      }
    };
  }

  // node_modules/@tanstack/charts/dist/rect.js
  function rect(source, options) {
    const data = Array.isArray(source) ? source : Array.from(source);
    const xScale = options.xScale ?? "x";
    const yScale = options.yScale ?? "y";
    return createMark(
      ({ markIndex }) => {
        const id = options.id ?? `rect-${markIndex}`;
        const xValues = channelValues(
          data,
          options.x,
          (_datum, { index }) => index
        );
        const x1Values = channelValues(
          data,
          options.x1,
          (_datum, { index }) => options.x === void 0 ? index : xValues[index]
        );
        const x2Values = channelValues(
          data,
          options.x2,
          (_datum, { index }) => xValues[index]
        );
        const yValues = channelValues(
          data,
          options.y,
          (datum) => typeof datum === "number" ? datum : void 0
        );
        const y1Values = channelValues(
          data,
          options.y1,
          (_datum, { index }) => yValues[index]
        );
        const y2Values = channelValues(
          data,
          options.y2,
          (_datum, { index }) => yValues[index]
        );
        const zValues = channelValues(data, options.z, () => null);
        const colorValues = options.color === void 0 ? zValues : channelValues(data, options.color, () => null);
        const keys = inferredKeyValues(data, options.key, {
          groups: zValues,
          candidates: [
            compositeKeyValues(x1Values, x2Values, y1Values, y2Values)
          ],
          markId: id,
          warningIdentity: options
        });
        return {
          id,
          states: markStates(data, options.states),
          channels: {
            x: {
              scale: xScale,
              values: [...x1Values, ...x2Values].filter(isChartValue)
            },
            y: {
              scale: yScale,
              values: [...y1Values, ...y2Values].filter(isChartValue)
            },
            color: {
              scale: "color",
              values: colorValues.filter(isChartKey)
            }
          },
          render: ({ scales, color: resolveColor }) => {
            const nodes = [];
            const inset = Math.max(0, options.inset ?? 0.75);
            data.forEach((datum, datumIndex) => {
              const xValue = xValues[datumIndex];
              const x1Value = x1Values[datumIndex];
              const x2Value = x2Values[datumIndex];
              const yValue = yValues[datumIndex];
              const y1Value = y1Values[datumIndex];
              const y2Value = y2Values[datumIndex];
              if (!isChartValue(x1Value) || !isChartValue(x2Value) || !isChartValue(y1Value) || !isChartValue(y2Value))
                return;
              const x1 = scales[xScale].map(x1Value);
              const x2 = scales[xScale].map(x2Value);
              const y1 = scales[yScale].map(y1Value);
              const y2 = scales[yScale].map(y2Value);
              const categoricalWidth = valueKey(x1Value) === valueKey(x2Value) ? scales[xScale].bandwidth : 0;
              const categoricalHeight = valueKey(y1Value) === valueKey(y2Value) ? scales[yScale].bandwidth : 0;
              const left2 = categoricalWidth > 0 ? x1 - categoricalWidth / 2 : Math.min(x1, x2);
              const top = categoricalHeight > 0 ? y1 - categoricalHeight / 2 : Math.min(y1, y2);
              const width = categoricalWidth || Math.max(0, Math.abs(x2 - x1));
              const height = categoricalHeight || Math.max(0, Math.abs(y2 - y1));
              const group2 = zValues[datumIndex] ?? null;
              const color2 = options.fill ?? resolveColor(colorValues[datumIndex] ?? null);
              const key = `${id}:${valueKey(group2)}:${valueKey(keys[datumIndex])}`;
              const paintedX = left2 + inset;
              const paintedY = top + inset;
              const paintedWidth = Math.max(0, width - inset * 2);
              const paintedHeight = Math.max(0, height - inset * 2);
              const pointXValue = isChartValue(xValue) ? xValue : x2Value;
              const pointYValue = isChartValue(yValue) ? yValue : y2Value;
              const point3 = {
                key,
                markId: id,
                group: group2,
                groupLabel: group2 == null ? id : String(group2),
                datum,
                datumIndex,
                xValue: pointXValue,
                yValue: pointYValue,
                x1Value,
                x2Value,
                y1Value,
                y2Value,
                xInterval: "range",
                yInterval: "range",
                x: left2 + width / 2,
                y: top + height / 2,
                color: color2
              };
              nodes.push({
                kind: "rect",
                key,
                x: paintedX,
                y: paintedY,
                width: paintedWidth,
                height: paintedHeight,
                radius: options.radius,
                inset,
                interaction: { point: point3 },
                style: {
                  fill: color2,
                  fillOpacity: options.fillOpacity,
                  stroke: options.stroke,
                  strokeWidth: options.strokeWidth
                }
              });
            });
            return {
              nodes: [
                {
                  kind: "group",
                  key: id,
                  className: "ts-chart__rect",
                  ariaHidden: true,
                  children: nodes
                }
              ]
            };
          }
        };
      },
      options.motion,
      options.renderer
    );
  }
  function cell(source, options) {
    return rect(source, options);
  }

  // node_modules/@tanstack/charts/dist/stack.js
  function stack(options = {}) {
    return { type: "stack", ...options };
  }

  // node_modules/@tanstack/charts/dist/proportional-interval-internal.js
  function allocateProportionalIntervals(weights, options = {}) {
    const start = options.start ?? 0;
    const end = options.end ?? 1;
    const gap = options.gap ?? 0;
    assertFinite(start, "start");
    assertFinite(end, "end");
    assertNonnegativeFinite(gap, "gap");
    const span = end - start;
    if (!Number.isFinite(span)) {
      throw new TypeError("proportional intervals: extent span must be finite");
    }
    let positiveCount = 0;
    let unscaledTotal = 0;
    let maximum = 0;
    weights.forEach((weight, index) => {
      if (!Number.isFinite(weight) || weight < 0) {
        throw new TypeError(
          `proportional intervals: weight at index ${index} must be nonnegative and finite`
        );
      }
      if (weight > 0) positiveCount += 1;
      unscaledTotal += weight;
      maximum = Math.max(maximum, weight);
    });
    const valueScale = Number.isFinite(unscaledTotal) ? 1 : maximum;
    const total = valueScale === 1 ? unscaledTotal : weights.reduce((sum3, weight) => sum3 + weight / valueScale, 0);
    const absoluteSpan = Math.abs(span);
    const gapCount = positiveCount === 0 ? 0 : Math.max(0, positiveCount - 1) + (options.gapAfterLast === true ? 1 : 0);
    const totalGap = gapCount * gap;
    if (!Number.isFinite(totalGap) || totalGap > absoluteSpan) {
      throw new TypeError(
        "proportional intervals: gap leaves insufficient extent"
      );
    }
    const drawableSpan = absoluteSpan - totalGap;
    if (positiveCount > 0 && drawableSpan <= 0) {
      throw new TypeError(
        "proportional intervals: positive weights require drawable extent"
      );
    }
    const direction = span < 0 ? -1 : 1;
    const intervals = [];
    let cursor = start;
    let remainingPositive = positiveCount;
    for (const weight of weights) {
      const fraction = total === 0 ? 0 : weight / valueScale / total;
      const intervalStart = cursor;
      let intervalEnd = cursor;
      if (weight > 0) {
        remainingPositive -= 1;
        intervalEnd = remainingPositive === 0 ? end - (options.gapAfterLast === true ? direction * gap : 0) : cursor + direction * drawableSpan * fraction;
        cursor = intervalEnd;
        if (remainingPositive > 0 || options.gapAfterLast === true) {
          cursor += direction * gap;
        }
      }
      intervals.push({ fraction, start: intervalStart, end: intervalEnd });
    }
    return intervals;
  }
  function assertFinite(value2, name) {
    if (!Number.isFinite(value2)) {
      throw new TypeError(`proportional intervals: ${name} must be finite`);
    }
  }
  function assertNonnegativeFinite(value2, name) {
    if (!Number.isFinite(value2) || value2 < 0) {
      throw new TypeError(
        `proportional intervals: ${name} must be nonnegative and finite`
      );
    }
  }

  // node_modules/@tanstack/charts/dist/rule.js
  function ruleY(source, options = {}) {
    const data = Array.isArray(source) ? source : Array.from(source);
    const yScale = options.yScale ?? "y";
    return createMark(
      ({ markIndex }) => {
        const id = options.id ?? `rule-y-${markIndex}`;
        const values = channelValues(
          data,
          options.y,
          (datum) => isChartValue(datum) ? datum : void 0
        );
        const colorValues = channelValues(data, options.color, () => null);
        return {
          id,
          channels: {
            y: { scale: yScale, values: values.filter(isChartValue) },
            color: {
              scale: "color",
              values: colorValues.filter(isChartKey)
            }
          },
          render: ({ scales, chart, theme, color: resolveColor }) => {
            const children = [];
            const focusAnchors = [];
            data.forEach((datum, index) => {
              const yValue = values[index];
              if (!isChartValue(yValue)) return;
              const key = `${id}:${valueKey(yValue)}:${index}`;
              children.push({
                kind: "rule",
                key,
                x1: chart.x,
                x2: chart.x + chart.width,
                y1: scales[yScale].map(yValue),
                y2: scales[yScale].map(yValue),
                style: {
                  stroke: visualValue(
                    options.stroke,
                    datum,
                    index,
                    data,
                    colorValues[index] == null ? theme.foreground : resolveColor(colorValues[index])
                  ),
                  strokeOpacity: options.strokeOpacity ?? 0.5,
                  strokeWidth: options.strokeWidth,
                  strokeDasharray: options.strokeDasharray
                }
              });
              focusAnchors.push({
                key,
                markId: id,
                group: isChartKey(colorValues[index]) ? colorValues[index] : null,
                datum,
                datumIndex: index,
                yValue
              });
            });
            return {
              nodes: [
                {
                  kind: "group",
                  key: id,
                  className: "ts-chart__rule ts-chart__rule-y",
                  ariaHidden: true,
                  children
                }
              ],
              focusAnchors
            };
          }
        };
      },
      options.motion,
      options.renderer
    );
  }

  // node_modules/@tanstack/charts/dist/text.js
  function text(source, options = {}) {
    const data = Array.isArray(source) ? source : Array.from(source);
    const xScale = options.xScale ?? "x";
    const yScale = options.yScale ?? "y";
    return createMark(
      ({ markIndex }) => {
        const id = options.id ?? `text-${markIndex}`;
        const xValues = channelValues(
          data,
          options.x,
          (_datum, { index }) => index
        );
        const yValues = channelValues(
          data,
          options.y,
          (datum) => typeof datum === "number" ? datum : void 0
        );
        const textValues = channelValues(
          data,
          options.text,
          (datum) => datum == null ? "" : String(datum)
        );
        const zValues = channelValues(data, options.z, () => null);
        const colorValues = options.color === void 0 ? zValues : channelValues(data, options.color, () => null);
        const keys = inferredKeyValues(data, options.key, {
          groups: zValues,
          candidates: [xValues, yValues, compositeKeyValues(xValues, yValues)],
          markId: id,
          warningIdentity: options
        });
        const anchors = data.map(
          (datum, datumIndex) => visualValue(options.anchor, datum, datumIndex, data, "middle")
        );
        const dxValues = data.map(
          (datum, datumIndex) => visualValue(options.dx, datum, datumIndex, data, 0)
        );
        const dyValues = data.map(
          (datum, datumIndex) => visualValue(options.dy, datum, datumIndex, data, 0)
        );
        const rotateValues = options.rotate === void 0 ? void 0 : data.map(
          (datum, datumIndex) => visualValue(options.rotate, datum, datumIndex, data, 0)
        );
        const resolveLabel = (context, datumIndex) => {
          const xValue = xValues[datumIndex];
          const yValue = yValues[datumIndex];
          const textValue = textValues[datumIndex];
          if (!isChartValue(xValue) || !isChartValue(yValue) || textValue == null) {
            return void 0;
          }
          const group2 = zValues[datumIndex] ?? null;
          const colorValue = colorValues[datumIndex] ?? null;
          const node = {
            kind: "label",
            key: `${id}:${valueKey(group2)}:${valueKey(keys[datumIndex])}`,
            x: context.scales[xScale].map(xValue) + (dxValues[datumIndex] ?? 0),
            y: context.scales[yScale].map(yValue) + (dyValues[datumIndex] ?? 0),
            text: String(textValue),
            anchor: anchors[datumIndex],
            baseline: "middle",
            rotate: rotateValues?.[datumIndex],
            fontSize: options.fontSize,
            fontWeight: options.fontWeight
          };
          return { node, xValue, yValue, group: group2, colorValue };
        };
        return {
          id,
          states: markStates(data, options.states),
          channels: {
            x: { scale: xScale, values: xValues.filter(isChartValue) },
            y: { scale: yScale, values: yValues.filter(isChartValue) },
            color: {
              scale: "color",
              values: colorValues.filter(isChartKey)
            }
          },
          layoutLabels: (context) => data.flatMap((_datum, datumIndex) => {
            const resolved = resolveLabel(context, datumIndex);
            return resolved ? [resolved.node] : [];
          }),
          render: (context) => {
            const { theme, color: resolveColor } = context;
            const nodes = [];
            const points = [];
            data.forEach((datum, datumIndex) => {
              const resolved = resolveLabel(context, datumIndex);
              if (!resolved) return;
              const { node, xValue, yValue, group: group2, colorValue } = resolved;
              const color2 = visualValue(
                options.fill,
                datum,
                datumIndex,
                data,
                colorValue == null ? theme.foreground : resolveColor(colorValue)
              );
              nodes.push({
                ...node,
                style: { fill: color2 }
              });
              points.push({
                key: node.key,
                markId: id,
                group: group2,
                groupLabel: group2 == null ? id : String(group2),
                datum,
                datumIndex,
                xValue,
                yValue,
                x: node.x,
                y: node.y,
                color: color2
              });
            });
            return {
              nodes: [
                {
                  kind: "group",
                  key: id,
                  className: "ts-chart__text",
                  ariaHidden: true,
                  children: nodes
                }
              ],
              points
            };
          }
        };
      },
      options.motion,
      options.renderer
    );
  }

  // node_modules/@tanstack/charts/dist/scales/intern.js
  function intern(value2) {
    return value2 instanceof Date ? `date:${value2.getTime()}` : `${typeof value2}:${String(value2)}`;
  }
  function uniqueDomain(values) {
    const domain = [];
    const index = /* @__PURE__ */ new Map();
    for (const value2 of values) {
      const key = intern(value2);
      if (index.has(key)) continue;
      index.set(key, domain.length);
      domain.push(value2);
    }
    return { domain, index };
  }

  // node_modules/@tanstack/charts/dist/scales/band-kernel.js
  function createBandScale(point3, first, second) {
    let domain = [];
    let index = /* @__PURE__ */ new Map();
    let positions = [];
    let range2 = [0, 1];
    let step = 1;
    let bandwidth = point3 ? 0 : 1;
    let round = false;
    let paddingInner = point3 ? 1 : 0;
    let paddingOuter = 0;
    let align = 0.5;
    const scale = ((value2) => {
      const position = index.get(intern(value2));
      return position === void 0 ? void 0 : positions[position];
    });
    const rescale = () => {
      const count2 = domain.length;
      const reverse = range2[1] < range2[0];
      let start = reverse ? range2[1] : range2[0];
      const stop = reverse ? range2[0] : range2[1];
      step = (stop - start) / Math.max(1, count2 - paddingInner + paddingOuter * 2);
      if (round) step = Math.floor(step);
      start += (stop - start - step * (count2 - paddingInner)) * align;
      bandwidth = step * (1 - paddingInner);
      if (round) {
        start = Math.round(start);
        bandwidth = Math.round(bandwidth);
      }
      positions = Array.from(
        { length: count2 },
        (_value, position) => start + step * position
      );
      if (reverse) positions.reverse();
      return scale;
    };
    scale.domain = ((values) => {
      if (values === void 0) return domain.slice();
      const next = uniqueDomain(values);
      domain = next.domain;
      index = next.index;
      return rescale();
    });
    scale.range = ((values) => {
      if (values === void 0) return [...range2];
      range2 = pair(values);
      return rescale();
    });
    scale.rangeRound = (values) => {
      range2 = pair(values);
      round = true;
      return rescale();
    };
    scale.bandwidth = () => bandwidth;
    scale.step = () => step;
    scale.round = ((value2) => {
      if (value2 === void 0) return round;
      round = Boolean(value2);
      return rescale();
    });
    scale.padding = ((value2) => {
      if (value2 === void 0) return paddingInner;
      paddingOuter = number4(value2);
      paddingInner = Math.min(1, paddingOuter);
      return rescale();
    });
    scale.paddingInner = ((value2) => {
      if (value2 === void 0) return paddingInner;
      paddingInner = Math.min(1, number4(value2));
      return rescale();
    });
    scale.paddingOuter = ((value2) => {
      if (value2 === void 0) return paddingOuter;
      paddingOuter = number4(value2);
      return rescale();
    });
    scale.align = ((value2) => {
      if (value2 === void 0) return align;
      align = Math.max(0, Math.min(1, number4(value2)));
      return rescale();
    });
    scale.copy = () => {
      const copy = createBandScale(false, domain, range2);
      return copy.round(round).paddingInner(paddingInner).paddingOuter(paddingOuter).align(align);
    };
    if (point3) {
      const pointScale = scale;
      pointScale.bandwidth = () => 0;
      pointScale.padding = scale.paddingOuter;
      pointScale.copy = () => {
        const copy = createBandScale(true, domain, range2);
        return copy.round(round).padding(paddingOuter).align(align);
      };
      delete pointScale.paddingInner;
      delete pointScale.paddingOuter;
    }
    rescale();
    if (second !== void 0) {
      scale.domain(first).range(second);
    } else if (first !== void 0) {
      scale.range(first);
    }
    return scale;
  }
  function pair(values) {
    const resolved = Array.from(values, number4);
    if (resolved.length !== 2 || resolved.some((value2) => !Number.isFinite(value2))) {
      throw new TypeError("A scale range requires exactly two finite numbers");
    }
    return [resolved[0], resolved[1]];
  }
  function number4(value2) {
    return Number(value2);
  }

  // node_modules/@tanstack/charts/dist/scales/band.js
  function scaleBand(first, second) {
    return createBandScale(false, first, second);
  }

  // node_modules/@tanstack/charts/dist/scales/ticks.js
  var preferredMultiples = [1, 2, 5, 10];
  function ticks2(start, stop, count2) {
    if (!(count2 > 0)) return [];
    if (start === stop) return [start];
    const descending2 = stop < start;
    const plan = createTickPlan(
      descending2 ? stop : start,
      descending2 ? start : stop,
      count2
    );
    if (!(plan.lastIndex >= plan.firstIndex)) return [];
    return Array.from(
      { length: plan.lastIndex - plan.firstIndex + 1 },
      (_value, offset) => valueAtIndex(
        descending2 ? plan.lastIndex - offset : plan.firstIndex + offset,
        plan.interval
      )
    );
  }
  function tickIncrement2(start, stop, count2) {
    return createTickPlan(start, stop, count2).interval;
  }
  function tickStep2(start, stop, count2) {
    const descending2 = stop < start;
    const interval = tickIncrement2(
      descending2 ? stop : start,
      descending2 ? start : stop,
      count2
    );
    const magnitude = interval < 0 ? -1 / interval : interval;
    return descending2 ? -magnitude : magnitude;
  }
  function createTickPlan(start, stop, count2) {
    let requestedCount = count2;
    while (true) {
      const interval = chooseInterval(start, stop, requestedCount);
      const firstIndex = indexAtOrAbove(start, interval);
      const lastIndex = indexAtOrBelow(stop, interval);
      if (lastIndex >= firstIndex || !(requestedCount >= 0.5 && requestedCount < 2)) {
        return { firstIndex, lastIndex, interval };
      }
      requestedCount *= 2;
    }
  }
  function chooseInterval(start, stop, count2) {
    const target = (stop - start) / Math.max(0, count2);
    const exponent = Math.floor(Math.log10(target));
    const decade = 10 ** exponent;
    const multiple = closestPreferredMultiple(target / decade);
    return exponent < 0 ? -(10 ** -exponent) / multiple : decade * multiple;
  }
  function closestPreferredMultiple(normalizedTarget) {
    let selected = preferredMultiples[0];
    for (const candidate of preferredMultiples.slice(1)) {
      const midpoint = Math.sqrt(selected * candidate);
      if (!(normalizedTarget >= midpoint)) break;
      selected = candidate;
    }
    return selected;
  }
  function indexAtOrAbove(value2, interval) {
    const position = interval < 0 ? value2 * -interval : value2 / interval;
    const nearest = Math.round(position);
    return nearest < position ? nearest + 1 : nearest;
  }
  function indexAtOrBelow(value2, interval) {
    const position = interval < 0 ? value2 * -interval : value2 / interval;
    const nearest = Math.round(position);
    return nearest > position ? nearest - 1 : nearest;
  }
  function valueAtIndex(index, interval) {
    return interval < 0 ? index / -interval : index * interval;
  }

  // node_modules/@tanstack/charts/dist/scales/linear.js
  function scaleLinear(first, second) {
    let domain = [0, 1];
    let range2 = [0, 1];
    let clamped = false;
    const scale = ((value2) => {
      if (value2 == null || !Number.isFinite(Number(value2))) return void 0;
      return interpolate(Number(value2), domain, range2, clamped);
    });
    scale.domain = ((values) => {
      if (values === void 0) return [...domain];
      domain = pair2(values, "domain");
      return scale;
    });
    scale.range = ((values) => {
      if (values === void 0) return [...range2];
      range2 = pair2(values, "range");
      return scale;
    });
    scale.invert = (value2) => interpolate(value2, range2, domain, clamped);
    scale.clamp = ((value2) => {
      if (value2 === void 0) return clamped;
      clamped = Boolean(value2);
      return scale;
    });
    scale.ticks = (count2 = 10) => ticks2(domain[0], domain[1], count2);
    scale.tickFormat = (count2 = 10) => {
      const step = Math.abs(tickStep2(domain[0], domain[1], count2));
      const digits = step > 0 && step < 1 ? Math.min(20, Math.max(0, -Math.floor(Math.log10(step)))) : 0;
      return (value2) => {
        const formatted = digits ? value2.toFixed(digits) : String(value2);
        return formatted === "-0" ? "0" : formatted;
      };
    };
    scale.nice = (count2 = 10) => {
      let start = domain[0];
      let stop = domain[1];
      let startIndex = 0;
      let stopIndex = 1;
      if (stop < start) {
        ;
        [start, stop] = [stop, start];
        [startIndex, stopIndex] = [stopIndex, startIndex];
      }
      let previousStep;
      for (let remaining = 10; remaining > 0; remaining--) {
        const step = tickIncrement2(start, stop, count2);
        if (step === previousStep) {
          const next = [...domain];
          next[startIndex] = start;
          next[stopIndex] = stop;
          domain = next;
          break;
        }
        if (step > 0) {
          start = Math.floor(start / step) * step;
          stop = Math.ceil(stop / step) * step;
        } else if (step < 0) {
          start = Math.ceil(start * step) / step;
          stop = Math.floor(stop * step) / step;
        } else {
          break;
        }
        previousStep = step;
      }
      return scale;
    };
    scale.copy = () => scaleLinear(domain, range2).clamp(clamped);
    if (second !== void 0) {
      scale.domain(first).range(second);
    } else if (first !== void 0) {
      scale.range(first);
    }
    return scale;
  }
  function interpolate(value2, domain, range2, clamped) {
    const span = domain[1] - domain[0];
    let ratio = span ? (value2 - domain[0]) / span : 0.5;
    if (clamped) ratio = Math.max(0, Math.min(1, ratio));
    return range2[0] + ratio * (range2[1] - range2[0]);
  }
  function pair2(values, name) {
    const resolved = Array.from(values, Number);
    if (resolved.length !== 2 || resolved.some((value2) => !Number.isFinite(value2))) {
      throw new TypeError(
        `A linear scale ${name} requires exactly two finite numbers`
      );
    }
    return [resolved[0], resolved[1]];
  }

  // node_modules/@tanstack/charts/dist/scales/point.js
  function scalePoint(first, second) {
    return createBandScale(true, first, second);
  }

  // node_modules/@tanstack/charts/dist/tooltip-placement.js
  var defaultPlacements = [
    "top",
    "bottom",
    "right",
    "left"
  ];
  function resolveChartTooltipPlacement(anchor, tooltip2, boundary, placement, offset) {
    const edge = 8;
    const gap = offset !== void 0 && Number.isFinite(offset) ? Math.max(0, offset) : 10;
    const minimumLeft = boundary.left + edge;
    const minimumTop = boundary.top + edge;
    const maxLeft = Math.max(minimumLeft, boundary.right - edge - tooltip2.width);
    const maxTop = Math.max(minimumTop, boundary.bottom - edge - tooltip2.height);
    const placements = placement === void 0 || placement === "auto" ? defaultPlacements : Array.isArray(placement) ? placement.length ? placement : defaultPlacements : [placement];
    const candidates = placements.map(
      (candidate) => tooltipPlacement(
        candidate,
        anchor.x,
        anchor.y,
        tooltip2.width,
        tooltip2.height,
        gap
      )
    );
    let selected = candidates[0];
    let selectedOverflow = overflow(
      selected,
      tooltip2.width,
      tooltip2.height,
      boundary,
      edge
    );
    for (const candidate of candidates) {
      const candidateOverflow = overflow(
        candidate,
        tooltip2.width,
        tooltip2.height,
        boundary,
        edge
      );
      if (candidateOverflow === 0) {
        selected = candidate;
        break;
      }
      if (candidateOverflow < selectedOverflow) {
        selected = candidate;
        selectedOverflow = candidateOverflow;
      }
    }
    return {
      left: clamp(selected.left, minimumLeft, maxLeft),
      top: clamp(selected.top, minimumTop, maxTop),
      placement: selected.placement
    };
  }
  function tooltipPlacement(placement, anchorX, anchorY, width, height, gap) {
    const xDirection = placement.endsWith("right") || placement === "right" ? 1 : placement.endsWith("left") || placement === "left" ? -1 : 0;
    const yDirection = placement.startsWith("bottom") || placement === "bottom" ? 1 : placement.startsWith("top") || placement === "top" ? -1 : 0;
    return {
      placement,
      left: anchorX + (xDirection - 1) * width / 2 + xDirection * gap,
      top: anchorY + (yDirection - 1) * height / 2 + yDirection * gap
    };
  }
  function overflow(position, width, height, boundary, edge) {
    return Math.max(0, boundary.left + edge - position.left) + Math.max(0, position.left + width + edge - boundary.right) + Math.max(0, boundary.top + edge - position.top) + Math.max(0, position.top + height + edge - boundary.bottom);
  }
  function clamp(value2, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value2));
  }

  // node_modules/@tanstack/charts/dist/tooltip-position.js
  function placeTooltip(tooltip2, anchorX, anchorY, boundary, placement, offset) {
    const width = tooltip2.offsetWidth;
    const height = tooltip2.offsetHeight;
    const resolved = resolveChartTooltipPlacement(
      { x: anchorX, y: anchorY },
      { width, height },
      boundary,
      placement,
      offset
    );
    tooltip2.style.left = `${resolved.left}px`;
    tooltip2.style.top = `${resolved.top}px`;
    tooltip2.dataset.placement = resolved.placement;
  }

  // node_modules/@tanstack/charts/dist/tooltip-model.js
  function orderChartTooltipPoints(points, scene, sort) {
    if (sort === "focus") return [...points];
    if (typeof sort === "function") return [...points].sort(sort);
    if (sort !== "color-domain") {
      const first = points[0];
      const sharedX = first !== void 0 && points.every((point3) => sameChartTooltipValue(point3.xValue, first.xValue));
      const sharedY = first !== void 0 && points.every((point3) => sameChartTooltipValue(point3.yValue, first.yValue));
      return [...points].sort(
        (left2, right2) => sharedY && !sharedX ? left2.x - right2.x || left2.y - right2.y : left2.y - right2.y || left2.x - right2.x
      );
    }
    return [...points].sort(
      (left2, right2) => colorOrder(scene, left2.group) - colorOrder(scene, right2.group)
    );
  }
  function createChartTooltipContent(points, scene, pinned = false, options, primaryPoint) {
    const point3 = points[0];
    if (!point3) return { rows: [] };
    const context = createTooltipContentContext(scene, pinned, options);
    const content = options?.content?.(points, context);
    if (content !== void 0) return content;
    const formatted = options?.formatGroup?.(points, context) ?? options?.format?.(primaryPoint ?? point3, context);
    if (formatted !== void 0) return formatted;
    return defaultTooltipContent(points, scene, options, context);
  }
  function resolveChartTooltipAnchor(point3, points, scene, pointer, options, focus = {
    primary: point3,
    group: points,
    source: "programmatic",
    pinned: false
  }) {
    const fallback = { x: point3.x, y: point3.y };
    const anchor = options?.anchor ?? "point";
    if (anchor === "point") return fallback;
    if (anchor === "pointer") return pointer ?? fallback;
    if (anchor === "group-center") {
      let x1 = point3.x;
      let x2 = point3.x;
      let y1 = point3.y;
      let y2 = point3.y;
      for (const candidate of points) {
        x1 = Math.min(x1, candidate.x);
        x2 = Math.max(x2, candidate.x);
        y1 = Math.min(y1, candidate.y);
        y2 = Math.max(y2, candidate.y);
      }
      return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
    }
    if (typeof anchor === "object") {
      return {
        x: resolveTooltipCoordinate(
          "x",
          anchor.x,
          point3,
          points,
          scene,
          pointer,
          fallback.x
        ),
        y: resolveTooltipCoordinate(
          "y",
          anchor.y,
          point3,
          points,
          scene,
          pointer,
          fallback.y
        )
      };
    }
    const resolved = anchor(points, {
      focus,
      pointer,
      plot: scene.chart,
      surface: { width: scene.width, height: scene.height },
      scales: scene.scales
    });
    return resolved && Number.isFinite(resolved.x) && Number.isFinite(resolved.y) ? resolved : fallback;
  }
  function formatChartTooltipValue(value2) {
    return value2 instanceof Date ? Number.isNaN(+value2) ? "Invalid Date" : value2.toISOString().replace("T00:00:00.000Z", "") : typeof value2 === "number" ? value2.toLocaleString() : String(value2);
  }
  function createTooltipContentContext(scene, pinned, options) {
    const x2 = findTooltipChannelItem(options?.items, "x");
    const y2 = findTooltipChannelItem(options?.items, "y");
    return {
      pinned,
      xLabel: x2?.label ?? findSceneLabel(scene, "x-label") ?? "x",
      yLabel: y2?.label ?? findSceneLabel(scene, "y-label") ?? "y",
      formatX: formatChartTooltipValue,
      formatY: formatChartTooltipValue
    };
  }
  function defaultTooltipContent(points, scene, options, context) {
    const point3 = points[0];
    if (!point3) return { rows: [] };
    const x2 = findTooltipChannelItem(options?.items, "x");
    const y2 = findTooltipChannelItem(options?.items, "y");
    const group2 = findTooltipChannelItem(options?.items, "group");
    const sharedX = points.length > 1 && points.every(
      (candidate) => sameChartTooltipValue(candidate.xValue, point3.xValue)
    );
    const sharedY = points.length > 1 && points.every(
      (candidate) => sameChartTooltipValue(candidate.yValue, point3.yValue)
    );
    if (sharedX || sharedY) {
      const axis = sharedX ? "x" : "y";
      const axisItem = sharedX ? x2 : y2;
      const label = axisItem?.label ?? findSceneLabel(scene, `${axis}-label`);
      const value2 = formatPointAxis(point3, axis, axisItem, context);
      return {
        title: label ? `${label}: ${value2}` : value2,
        rows: points.map((candidate) => ({
          label: formatTooltipGroup(candidate, group2, context),
          value: formatPointAxis(
            candidate,
            sharedX ? "y" : "x",
            sharedX ? y2 : x2,
            context
          ),
          color: candidate.color
        }))
      };
    }
    if (points.length > 1) {
      return {
        rows: points.map((candidate) => ({
          label: formatTooltipGroup(candidate, group2, context),
          value: `${formatPointAxis(candidate, "x", x2, context)} \xB7 ${formatPointAxis(candidate, "y", y2, context)}`,
          color: candidate.color
        }))
      };
    }
    const items = options?.items;
    return {
      title: point3.group == null || items?.some(isTooltipGroupItem) ? void 0 : formatTooltipGroup(point3, group2, context),
      color: point3.group == null || items?.some(isTooltipGroupItem) ? void 0 : point3.color,
      rows: items ? tooltipItemRows(point3, items, context) : [
        {
          label: context.xLabel,
          value: formatPointAxis(point3, "x", x2, context)
        },
        {
          label: context.yLabel,
          value: formatPointAxis(point3, "y", y2, context)
        }
      ]
    };
  }
  function tooltipItemRows(point3, items, context) {
    return items.flatMap((item) => {
      if (typeof item === "string") {
        if (item === "group") {
          return [{ label: "Group", value: point3.groupLabel, color: point3.color }];
        }
        return [
          {
            label: item === "x" ? context.xLabel : context.yLabel,
            value: formatPointAxis(point3, item, void 0, context)
          }
        ];
      }
      if ("channel" in item) {
        const text2 = item.text?.(point3, context);
        if (item.text && text2 == null) return [];
        if (item.channel === "group") {
          return [
            {
              label: item.label ?? "Group",
              value: text2 ?? point3.groupLabel,
              color: point3.color
            }
          ];
        }
        return [
          {
            label: item.label ?? (item.channel === "x" ? context.xLabel : context.yLabel),
            value: text2 ?? formatPointAxis(point3, item.channel, void 0, context)
          }
        ];
      }
      if ("field" in item) {
        const value22 = point3.datum[item.field];
        if (value22 == null) return [];
        const text2 = item.text?.(point3, context);
        if (item.text && text2 == null) return [];
        return [
          {
            label: item.label ?? item.field,
            value: text2 ?? formatChartTooltipValue(value22)
          }
        ];
      }
      const value2 = item.text(point3, context);
      return value2 == null ? [] : [{ label: item.label ?? item.id, value: value2 }];
    });
  }
  function findTooltipChannelItem(items, channel) {
    const item = items?.find(
      (candidate) => tooltipItemChannel(candidate) === channel
    );
    return typeof item === "object" && "channel" in item ? item : void 0;
  }
  function tooltipItemChannel(item) {
    return typeof item === "string" ? item : "channel" in item ? item.channel : void 0;
  }
  function isTooltipGroupItem(item) {
    return tooltipItemChannel(item) === "group";
  }
  function formatTooltipGroup(point3, item, context) {
    return item?.text?.(point3, context) ?? point3.groupLabel;
  }
  function formatPointAxis(point3, axis, item, context) {
    const itemText = item?.text?.(point3, context);
    if (itemText != null) return itemText;
    const start = axis === "x" ? point3.x1Value : point3.y1Value;
    const end = axis === "x" ? point3.x2Value : point3.y2Value;
    const interval = axis === "x" ? point3.xInterval : point3.yInterval;
    if (interval === "difference" && typeof start === "number" && typeof end === "number") {
      return formatChartTooltipValue(end - start);
    }
    if (interval === "range" && start !== void 0 && end !== void 0 && !sameChartTooltipValue(start, end)) {
      return `${formatChartTooltipValue(start)}\u2013${formatChartTooltipValue(end)}`;
    }
    return formatChartTooltipValue(axis === "x" ? point3.xValue : point3.yValue);
  }
  function findSceneLabel(scene, key) {
    const axes = scene.nodes.find(
      (node) => node.kind === "group" && node.key === "axes"
    );
    if (axes?.kind !== "group") return void 0;
    const label = axes.children.find((node) => node.key === key);
    return label?.kind === "label" ? label.text : void 0;
  }
  function resolveTooltipCoordinate(axis, source, point3, points, scene, pointer, fallback) {
    if (source === "point") return axis === "x" ? point3.x : point3.y;
    if (source === "pointer") return pointer?.[axis] ?? fallback;
    if (source === "value") {
      const value2 = axis === "x" ? point3.xValue : point3.yValue;
      const scale = scene.scales[axis];
      const position = (scale?.viewport?.map ?? scale?.map)?.(value2);
      return position !== void 0 && Number.isFinite(position) ? position : fallback;
    }
    if (source === "group-center") {
      let minimum = axis === "x" ? point3.x : point3.y;
      let maximum = minimum;
      for (const candidate of points) {
        const position = axis === "x" ? candidate.x : candidate.y;
        minimum = Math.min(minimum, position);
        maximum = Math.max(maximum, position);
      }
      return (minimum + maximum) / 2;
    }
    const plot = scene.chart;
    if (axis === "x") {
      if (source === "plot-left") return plot.x;
      if (source === "plot-center") return plot.x + plot.width / 2;
      if (source === "plot-right") return plot.x + plot.width;
    } else {
      if (source === "plot-top") return plot.y;
      if (source === "plot-center") return plot.y + plot.height / 2;
      if (source === "plot-bottom") return plot.y + plot.height;
    }
    return fallback;
  }
  function colorOrder(scene, group2) {
    const index = group2 == null ? -1 : scene.colors.domain.indexOf(group2);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  }
  function sameChartTooltipValue(left2, right2) {
    return left2 instanceof Date && right2 instanceof Date ? left2.getTime() === right2.getTime() : Object.is(left2, right2);
  }

  // node_modules/@tanstack/charts/dist/tooltip.js
  var tooltip = {
    id: "tooltip",
    __chartExtensionType: "tooltip",
    __chartTooltipHost: "dom",
    create: createTooltipExtension
  };
  function createTooltipExtension(extensionContext) {
    let options = {};
    let element;
    let bodyElement;
    let activeBodyChange;
    let bodyVisible = false;
    let bodyScene;
    let bodyPoints = [];
    let bodyPinned = false;
    let bodyDirty = false;
    let paintContext;
    let anchor = null;
    let positionFrame;
    let resizeObserver;
    let portalExtension;
    let portalInstance;
    const { container } = extensionContext;
    const view = container.ownerDocument.defaultView;
    const tooltipMotion = extensionContext.motion;
    function update(nextOptions) {
      if (options !== nextOptions) bodyDirty = true;
      options = nextOptions;
      if (element) syncPortal();
    }
    function paint(nextContext) {
      paintContext = nextContext;
      if (options.visibility === "pinned" && !nextContext.pinned) {
        hide();
        return;
      }
      const tooltipElement = ensureElement();
      syncPortal();
      const motionSnapshot = tooltipMotion?.beforePaint(tooltipElement);
      tooltipElement.style.visibility = "hidden";
      tooltipElement.removeAttribute("hidden");
      tooltipElement.className = options.className ? `ts-chart-tooltip ${options.className}` : "ts-chart-tooltip";
      const points = orderChartTooltipPoints(
        nextContext.points,
        nextContext.scene,
        options.sort
      );
      const resolvedContent = createChartTooltipContent(
        points,
        nextContext.scene,
        nextContext.pinned,
        options,
        nextContext.point
      );
      const custom2 = renderTooltipBody(
        tooltipElement,
        points,
        resolvedContent,
        nextContext.pinned
      );
      if (!custom2) {
        if (typeof resolvedContent === "string") {
          paintPlainTooltip(tooltipElement, resolvedContent);
        } else {
          paintStructuredTooltip(tooltipElement, resolvedContent);
        }
      }
      configureTooltipSemantics(
        tooltipElement,
        resolvedContent,
        custom2,
        nextContext.pinned
      );
      tooltipElement.style.pointerEvents = nextContext.pinned ? "auto" : "none";
      tooltipElement.style.userSelect = nextContext.pinned ? "text" : "none";
      tooltipElement.dataset.sticky = String(nextContext.pinned);
      anchor = resolveChartTooltipAnchor(
        nextContext.point,
        points,
        nextContext.scene,
        nextContext.pointer,
        options,
        nextContext.focus
      );
      position();
      tooltipElement.style.removeProperty("visibility");
      if (motionSnapshot) {
        tooltipMotion?.afterPaint(tooltipElement, motionSnapshot, options.motion);
      }
    }
    function ensureElement() {
      if (element) return element;
      element = createTooltip(container.ownerDocument);
      element.addEventListener("keydown", handleKeyDown);
      resizeObserver = view?.ResizeObserver ? new view.ResizeObserver(schedulePosition) : void 0;
      resizeObserver?.observe(element);
      container.append(element);
      return element;
    }
    function handleKeyDown(event) {
      if (event.key !== "Escape" || !paintContext?.pinned) return;
      event.preventDefault();
      event.stopPropagation();
      extensionContext.dismiss();
    }
    function schedulePosition() {
      if (!paintContext || !anchor || positionFrame !== void 0) return;
      if (!view?.requestAnimationFrame) {
        position();
        return;
      }
      positionFrame = view.requestAnimationFrame(() => {
        positionFrame = void 0;
        position();
      });
    }
    function position() {
      if (!paintContext || !element || !anchor) return;
      if (portalInstance) {
        const visible = portalInstance.position({
          scene: paintContext.scene,
          surface: paintContext.surface,
          anchor,
          placement: options.placement,
          offset: options.offset
        });
        if (!visible) element.setAttribute("hidden", "");
        return;
      }
      placeTooltip(
        element,
        anchor.x,
        anchor.y,
        {
          left: 0,
          top: 0,
          right: paintContext.scene.width,
          bottom: paintContext.scene.height
        },
        options.placement,
        options.offset
      );
    }
    function syncPortal() {
      if (!element) return;
      const input = options.portal;
      const nextExtension = input ? "create" in input ? input : input.use : void 0;
      const nextOptions = input && "use" in input ? input : {};
      if (nextExtension !== portalExtension) {
        portalInstance?.destroy();
        portalInstance = void 0;
        portalExtension = nextExtension;
        if (nextExtension) {
          portalInstance = nextExtension.create(
            {
              container,
              element,
              schedulePosition
            },
            nextOptions
          );
        } else {
          moveToContainer();
        }
      } else {
        portalInstance?.update(nextOptions);
      }
    }
    function moveToContainer() {
      if (!element) return;
      if (element.parentNode !== container) container.append(element);
      element.removeAttribute("popover");
      delete element.dataset.tsChartTooltipPortal;
      Object.assign(element.style, {
        position: "absolute",
        zIndex: "1",
        right: "auto",
        bottom: "auto",
        margin: "0"
      });
    }
    function renderTooltipBody(tooltipElement, points, content, pinned) {
      const callback = extensionContext.bodyChange();
      if (!callback) {
        deactivateTooltipBody();
        return false;
      }
      if (activeBodyChange !== callback) {
        activeBodyChange?.(null);
        activeBodyChange = callback;
        bodyVisible = false;
        bodyElement = void 0;
      }
      if (!bodyElement) {
        bodyElement = tooltipElement.ownerDocument.createElement("div");
        bodyElement.className = "ts-chart-tooltip__body";
        tooltipElement.replaceChildren(bodyElement);
      }
      bodyElement.toggleAttribute("inert", !pinned);
      setTooltipContentAccessibility(tooltipElement, content);
      const changed = bodyDirty || !bodyVisible || bodyScene !== paintContext?.scene || bodyPinned !== pinned || !samePointList(points, bodyPoints);
      bodyDirty = false;
      bodyVisible = true;
      bodyScene = paintContext?.scene;
      bodyPoints = points;
      bodyPinned = pinned;
      if (changed) {
        callback({
          element: bodyElement,
          points,
          content,
          pinned,
          dismiss: extensionContext.dismiss
        });
      }
      return true;
    }
    function hideTooltipBody() {
      if (!bodyVisible) return;
      bodyVisible = false;
      activeBodyChange?.(null);
    }
    function deactivateTooltipBody() {
      hideTooltipBody();
      activeBodyChange = void 0;
      bodyElement = void 0;
      bodyScene = void 0;
      bodyPoints = [];
    }
    function hide() {
      paintContext = void 0;
      anchor = null;
      const currentElement = element;
      if (!currentElement || currentElement.hidden) {
        portalInstance?.hide();
        hideTooltipBody();
        return;
      }
      const complete = () => {
        portalInstance?.hide();
        currentElement.setAttribute("hidden", "");
        hideTooltipBody();
      };
      if (tooltipMotion?.hide(currentElement, options.motion, complete)) return;
      complete();
    }
    function destroy() {
      hide();
      deactivateTooltipBody();
      portalInstance?.destroy();
      portalInstance = void 0;
      portalExtension = void 0;
      if (positionFrame !== void 0) {
        view?.cancelAnimationFrame?.(positionFrame);
        positionFrame = void 0;
      }
      tooltipMotion?.destroy(element);
      resizeObserver?.disconnect();
      resizeObserver = void 0;
      element?.remove();
      element = void 0;
    }
    return {
      update,
      paint,
      hide,
      contains: (target) => Boolean(target && element?.contains(target)),
      destroy
    };
  }
  function samePointList(left2, right2) {
    return left2.length === right2.length && left2.every(
      (point3, index) => point3.key === right2[index]?.key && point3.markId === right2[index]?.markId && point3.datumIndex === right2[index]?.datumIndex
    );
  }
  function createTooltip(document2) {
    const tooltipElement = document2.createElement("div");
    tooltipElement.className = "ts-chart-tooltip";
    tooltipElement.setAttribute("role", "status");
    tooltipElement.setAttribute("aria-live", "polite");
    Object.assign(tooltipElement.style, {
      position: "absolute",
      zIndex: "1",
      maxWidth: "var(--ts-chart-tooltip-max-width, min(24rem, 80%))",
      padding: "var(--ts-chart-tooltip-padding, 0.4rem 0.55rem)",
      border: "var(--ts-chart-tooltip-border, 1px solid color-mix(in srgb, CanvasText 18%, transparent))",
      borderRadius: "var(--ts-chart-tooltip-border-radius, 0.45rem)",
      background: "var(--ts-chart-tooltip-background, Canvas)",
      color: "var(--ts-chart-tooltip-color, CanvasText)",
      boxShadow: "var(--ts-chart-tooltip-shadow, 0 6px 24px rgb(0 0 0 / 0.14))",
      font: "var(--ts-chart-tooltip-font, 500 0.75rem/1.3 system-ui, sans-serif)",
      pointerEvents: "none",
      overflowWrap: "anywhere"
    });
    tooltipElement.hidden = true;
    return tooltipElement;
  }
  function paintPlainTooltip(tooltipElement, text2) {
    setTooltipContentAccessibility(tooltipElement, text2);
    tooltipElement.textContent = text2;
  }
  function paintStructuredTooltip(tooltipElement, content) {
    const document2 = tooltipElement.ownerDocument;
    const children = [];
    if (content.title) {
      const title = document2.createElement("div");
      title.className = "ts-chart-tooltip__title";
      title.style.cssText = `display:flex;align-items:center;gap:.4rem;font-weight:650;margin-bottom:${content.rows.length ? ".3rem" : "0"}`;
      if (content.color)
        title.append(createTooltipSwatch(document2, content.color));
      title.append(content.title);
      children.push(title);
    }
    if (content.rows.length) {
      const rows = document2.createElement("div");
      rows.className = "ts-chart-tooltip__rows";
      rows.setAttribute("aria-hidden", "true");
      for (const row of content.rows) {
        const line = document2.createElement("div");
        line.className = "ts-chart-tooltip__row";
        line.style.cssText = "display:grid;grid-template-columns:.55rem minmax(0,1fr) auto;align-items:center;column-gap:.4rem";
        const swatch = row.color ? createTooltipSwatch(document2, row.color) : document2.createElement("span");
        const label = document2.createElement("span");
        label.textContent = row.label;
        const value2 = document2.createElement("span");
        value2.textContent = row.value;
        value2.style.cssText = "text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap";
        line.append(swatch, label, value2);
        rows.append(line);
      }
      children.push(rows);
    }
    tooltipElement.replaceChildren(...children);
    setTooltipContentAccessibility(tooltipElement, content);
  }
  function setTooltipContentAccessibility(tooltipElement, content) {
    if (typeof content === "string") {
      tooltipElement.removeAttribute("aria-label");
      tooltipElement.style.whiteSpace = "pre-wrap";
      return;
    }
    tooltipElement.style.whiteSpace = "normal";
    tooltipElement.setAttribute(
      "aria-label",
      [content.title, ...content.rows.map((row) => `${row.label}: ${row.value}`)].filter(Boolean).join("\n")
    );
  }
  function configureTooltipSemantics(tooltipElement, content, custom2, pinned) {
    if (custom2 && typeof content === "string") {
      tooltipElement.setAttribute("aria-label", content);
    }
    if (custom2 && pinned) {
      tooltipElement.setAttribute("role", "dialog");
      tooltipElement.setAttribute("aria-modal", "false");
      tooltipElement.removeAttribute("aria-live");
      return;
    }
    tooltipElement.setAttribute("role", "status");
    tooltipElement.setAttribute("aria-live", "polite");
    tooltipElement.removeAttribute("aria-modal");
    if (!custom2 && typeof content === "string") {
      tooltipElement.removeAttribute("aria-label");
    }
  }
  function createTooltipSwatch(document2, color2) {
    const swatch = document2.createElement("span");
    swatch.className = "ts-chart-tooltip__swatch";
    swatch.setAttribute("aria-hidden", "true");
    swatch.style.cssText = "display:block;width:.55rem;height:.55rem;border-radius:.15rem;box-shadow:inset 0 0 0 1px rgb(0 0 0/.12)";
    swatch.style.background = color2;
    return swatch;
  }

  // node_modules/@tanstack/charts/dist/polar-mark-internal.js
  function createPolarMark(initialize, motion, renderer) {
    return {
      ...motion === void 0 ? {} : { motion },
      ...renderer === void 0 ? {} : { renderer },
      initialize(context) {
        const initialized = initialize(context);
        const withMotion = motion === void 0 || initialized.motion !== void 0 ? initialized : { ...initialized, motion };
        if (renderer === void 0) return withMotion;
        const render = withMotion.render;
        return {
          ...withMotion,
          render: (renderContext) => applyMarkRendererToScene(render(renderContext), renderer)
        };
      }
    };
  }

  // node_modules/@tanstack/charts/dist/polar-focus-internal.js
  var polarFocusGeometry = /* @__PURE__ */ Symbol("tanstack-charts-polar-focus");
  function withPolarFocusGeometry(point3, layout, angle, radius, offsetX, offsetY) {
    return Object.assign(point3, {
      [polarFocusGeometry]: [layout, angle, radius, offsetX, offsetY]
    });
  }

  // node_modules/@tanstack/charts/dist/polar-sector-internal.js
  var tau3 = Math.PI * 2;
  function tracePolarArcBoundary(generator, datum, index, data) {
    const points = [];
    const append2 = (x2, y2) => {
      if (!isFiniteNumber(x2) || !isFiniteNumber(y2)) return;
      const previous = points.at(-1);
      if (previous && Math.abs(previous[0] - x2) <= 1e-9 && Math.abs(previous[1] - y2) <= 1e-9) {
        return;
      }
      points.push([x2, y2]);
    };
    const context = {
      moveTo: append2,
      lineTo: append2,
      arc(centerX, centerY, radius, startAngle, endAngle, counterclockwise = false) {
        const sweep = canvasArcSweep(startAngle, endAngle, counterclockwise);
        if (!isFiniteNumber(sweep)) return;
        if (sweep === 0) {
          append2(
            centerX + radius * Math.cos(startAngle),
            centerY + radius * Math.sin(startAngle)
          );
          return;
        }
        const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 24)));
        for (let index2 = 0; index2 <= steps; index2 += 1) {
          const angle = startAngle + sweep * index2 / steps;
          append2(
            centerX + radius * Math.cos(angle),
            centerY + radius * Math.sin(angle)
          );
        }
      },
      closePath() {
      }
    };
    const previousContext = generator.context();
    generator.context(context);
    try {
      generator(datum, index, data);
    } finally {
      generator.context(previousContext);
    }
    return points;
  }
  function canvasArcSweep(startAngle, endAngle, counterclockwise) {
    const difference = endAngle - startAngle;
    if (!isFiniteNumber(difference)) return Number.NaN;
    if (counterclockwise) {
      if (difference <= -tau3) return -tau3;
      const sweep2 = difference % tau3;
      return sweep2 > 0 ? sweep2 - tau3 : sweep2;
    }
    if (difference >= tau3) return tau3;
    const sweep = difference % tau3;
    return sweep < 0 ? sweep + tau3 : sweep;
  }

  // node_modules/@tanstack/charts/dist/polar-pie.js
  var tau4 = Math.PI * 2;
  var fullRevolutionTolerance = 1e-12;
  function pie(source, options) {
    const data = toArray(source);
    const values = transformValues(data, options.value);
    const startAngle = options.startAngle ?? 0;
    const endAngle = options.endAngle ?? tau4;
    const gapAngle = options.gapAngle ?? 0;
    assertFinite2(startAngle, "startAngle");
    assertFinite2(endAngle, "endAngle");
    assertNonnegativeFinite2(gapAngle, "gapAngle");
    const sweep = endAngle - startAngle;
    if (!Number.isFinite(sweep) || Math.abs(sweep) > tau4) {
      throw new TypeError("pie: angular sweep must be no greater than 2\u03C0");
    }
    const sourceIndexes = values.flatMap((value2, sourceIndex) => {
      if (!isFiniteNumber3(value2)) return [];
      if (value2 < 0) {
        throw new TypeError(
          `pie: value at index ${sourceIndex} must be nonnegative`
        );
      }
      return [sourceIndex];
    });
    const ordered = orderedIndexes(
      data,
      sourceIndexes,
      options.orderBy,
      options.order
    );
    const completeRevolution = Math.abs(Math.abs(sweep) - tau4) <= fullRevolutionTolerance;
    assertPieGapCapacity(ordered, values, sweep, gapAngle, completeRevolution);
    const allocated = allocateProportionalIntervals(
      ordered.map((sourceIndex) => values[sourceIndex]),
      {
        start: startAngle,
        end: endAngle,
        gap: gapAngle,
        gapAfterLast: completeRevolution
      }
    );
    const intervals = /* @__PURE__ */ new Map();
    ordered.forEach((sourceIndex, index) => {
      const interval = allocated[index];
      const value2 = values[sourceIndex];
      intervals.set(sourceIndex, {
        value: value2,
        index,
        fraction: interval.fraction,
        startAngle: interval.start,
        endAngle: interval.end,
        angle: interval.start + (interval.end - interval.start) / 2,
        padAngle: 0
      });
    });
    return sourceIndexes.map((sourceIndex) => {
      const datum = data[sourceIndex];
      return {
        ...datum,
        ...intervals.get(sourceIndex),
        source: [datum],
        sourceIndexes: [sourceIndex]
      };
    });
  }
  function assertPieGapCapacity(ordered, values, sweep, gapAngle, completeRevolution) {
    const positiveCount = ordered.reduce(
      (count2, sourceIndex) => count2 + (values[sourceIndex] > 0 ? 1 : 0),
      0
    );
    const absoluteSweep = Math.abs(sweep);
    const gapCount = positiveCount === 0 ? 0 : completeRevolution ? positiveCount : Math.max(0, positiveCount - 1);
    const totalGap = gapCount * gapAngle;
    if (!Number.isFinite(totalGap) || totalGap > absoluteSweep) {
      throw new TypeError("pie: gapAngle leaves insufficient angular space");
    }
    const drawableSweep = absoluteSweep - totalGap;
    if (positiveCount > 0 && drawableSweep <= 0) {
      throw new TypeError("pie: positive values require drawable angular space");
    }
  }
  function isFiniteNumber3(value2) {
    return typeof value2 === "number" && Number.isFinite(value2);
  }
  function assertFinite2(value2, name) {
    if (!Number.isFinite(value2)) {
      throw new TypeError(`pie: ${name} must be finite`);
    }
  }
  function assertNonnegativeFinite2(value2, name) {
    if (!Number.isFinite(value2) || value2 < 0) {
      throw new TypeError(`pie: ${name} must be nonnegative and finite`);
    }
  }

  // node_modules/@tanstack/charts/dist/polar.js
  var tau5 = Math.PI * 2;
  function polar(options) {
    return createMarkWithScaleValues(
      ({ markIndex }) => {
        const id = options.id ?? `polar-${markIndex}`;
        const marks = options.marks.map((mark, polarMarkIndex) => {
          const initialized = mark.initialize({
            markIndex: polarMarkIndex,
            parentId: id
          });
          return {
            ...initialized,
            angleScale: initialized.angleScale ?? (initialized.requiresAngleScale ? "angle" : void 0),
            radiusScale: initialized.radiusScale ?? (initialized.requiresRadiusScale ? "radius" : void 0)
          };
        });
        const childMotions = new Map(
          marks.flatMap((mark, markIndex2) => {
            const childMotion = mark.motion ?? options.marks[markIndex2]?.motion;
            return childMotion === void 0 ? [] : [[mark.id, childMotion]];
          })
        );
        const motion = options.motion !== void 0 || childMotions.size > 0 ? (context) => resolveCompositeChildMotion(options.motion, childMotions, context) : void 0;
        return {
          id,
          ...motion === void 0 ? {} : { motion },
          channels: {
            color: {
              scale: "color",
              values: marks.flatMap((mark) => mark.colorValues)
            }
          },
          render: ({ chart, color: color2, theme }) => {
            const layout = resolvePolarLayout(options, chart, marks);
            for (const mark of marks) {
              if (mark.angleScale) {
                requiredPolarScale(
                  layout,
                  mark.angleScale,
                  "angle",
                  `Polar mark "${mark.id}"`
                );
              }
              if (mark.radiusScale) {
                requiredPolarScale(
                  layout,
                  mark.radiusScale,
                  "radius",
                  `Polar mark "${mark.id}"`
                );
              }
            }
            const nodes = [];
            const guideForeground = [];
            const points = [];
            for (const [guideIndex, guide] of (options.guides ?? []).entries()) {
              const rendered = guide.render({
                layout,
                theme,
                guideIndex,
                parentId: id
              });
              for (const node of rendered.background) nodes.push(node);
              for (const node of rendered.foreground ?? []) {
                guideForeground.push(node);
              }
            }
            for (const mark of marks) {
              const rendered = mark.render({ layout, color: color2, theme });
              for (const node of rendered.nodes) nodes.push(node);
              for (const point3 of rendered.points ?? []) points.push(point3);
            }
            for (const node of guideForeground) nodes.push(node);
            return {
              nodes: [
                {
                  kind: "group",
                  key: id,
                  className: classes("ts-chart__polar", options.className),
                  translateX: layout.centerX,
                  translateY: layout.centerY,
                  ariaHidden: true,
                  children: nodes
                }
              ],
              points
            };
          }
        };
      },
      options.motion,
      options.renderer
    );
  }
  function radialArc(source, options = {}) {
    const data = asArray(source);
    return createPolarMark2(
      ({ markIndex, parentId }) => {
        const id = options.id ?? `${parentId}:arc-${markIndex}`;
        const startAngles = channelValues(
          data,
          options.startAngle,
          (datum) => numberProperty(datum, "startAngle")
        );
        const endAngles = channelValues(
          data,
          options.endAngle,
          (datum) => numberProperty(datum, "endAngle")
        );
        const padAngles = channelValues(
          data,
          options.padAngle,
          (datum) => numberProperty(datum, "padAngle") ?? 0
        );
        const groups = channelValues(data, options.z, () => null);
        const colorValues = options.color === void 0 ? groups : channelValues(data, options.color, () => null);
        const keys = inferredKeyValues(data, options.key, { groups });
        return {
          id,
          colorValues: colorValues.filter(isChartKey),
          angleValues: [],
          radiusValues: [],
          includeZeroRadius: false,
          requiresAngleScale: false,
          requiresRadiusScale: false,
          render: ({ layout, color: resolveColor }) => {
            const innerRadius = resolveLength(options.innerRadius, layout, 0);
            const outerRadius = resolveLength(
              options.outerRadius,
              layout,
              layout.radius
            );
            const generator = options.generator?.(layout) ?? arc_default().startAngle((_datum, index) => startAngles[index] ?? 0).endAngle((_datum, index) => endAngles[index] ?? 0).padAngle((_datum, index) => padAngles[index] ?? 0).innerRadius(innerRadius).outerRadius(outerRadius).cornerRadius(resolveLength(options.cornerRadius, layout, 0));
            if (options.padRadius !== void 0 && !options.generator) {
              generator.padRadius(resolveLength(options.padRadius, layout, 0));
            }
            const nodes = [];
            const points = [];
            data.forEach((datum, datumIndex) => {
              const startAngle = startAngles[datumIndex];
              const endAngle = endAngles[datumIndex];
              const padAngle = padAngles[datumIndex];
              if (!options.generator && (!isFiniteNumber(startAngle) || !isFiniteNumber(endAngle) || !isFiniteNumber(padAngle))) {
                return;
              }
              const path2 = generator(datum, datumIndex, data);
              if (typeof path2 !== "string" || !path2) return;
              const group2 = groups[datumIndex] ?? null;
              const fallback = resolveColor(colorValues[datumIndex] ?? null);
              const fill = visualValue(
                options.fill,
                datum,
                datumIndex,
                data,
                fallback
              );
              const stroke = options.stroke === void 0 ? void 0 : visualValue(options.stroke, datum, datumIndex, data, fallback);
              const key = `${id}:${valueKey(group2)}:${valueKey(keys[datumIndex])}`;
              const generatedStart = generator.startAngle()(
                datum,
                datumIndex,
                data
              );
              const generatedEnd = generator.endAngle()(datum, datumIndex, data);
              const generatedInner = generator.innerRadius()(
                datum,
                datumIndex,
                data
              );
              const generatedOuter = generator.outerRadius()(
                datum,
                datumIndex,
                data
              );
              const centroid = generator.centroid(datum, datumIndex, data);
              const angleValue = (generatedStart + generatedEnd) / 2;
              const radiusValue = (generatedInner + generatedOuter) / 2;
              const point3 = withPolarFocusGeometry(
                {
                  key,
                  markId: id,
                  group: group2,
                  groupLabel: group2 == null ? id : String(group2),
                  datum,
                  datumIndex,
                  xValue: angleValue,
                  yValue: radiusValue,
                  x: layout.centerX + centroid[0],
                  y: layout.centerY + centroid[1],
                  color: fill
                },
                layout,
                angleValue,
                radiusValue,
                centroid[0],
                centroid[1]
              );
              nodes.push({
                kind: "area",
                key,
                points: tracePolarArcBoundary(generator, datum, datumIndex, data),
                path: path2,
                interaction: { point: point3, affinity: "geometry" },
                style: {
                  fill,
                  fillOpacity: options.fillOpacity,
                  stroke,
                  strokeOpacity: options.strokeOpacity,
                  strokeWidth: options.strokeWidth,
                  strokeDasharray: options.strokeDasharray,
                  opacity: options.opacity,
                  lineJoin: "round"
                }
              });
              points.push(point3);
            });
            return {
              nodes: [
                {
                  kind: "group",
                  key: id,
                  className: classes("ts-chart__arc", options.className),
                  ariaHidden: true,
                  children: nodes
                }
              ],
              points
            };
          }
        };
      },
      options.motion,
      options.renderer
    );
  }
  function radialLine(source, options = {}) {
    const data = asArray(source);
    return createPolarMark2(
      ({ markIndex, parentId }) => {
        const id = options.id ?? `${parentId}:radial-line-${markIndex}`;
        const angleScale = options.angleScale ?? "angle";
        const radiusScale = options.radiusScale ?? "radius";
        const angleValues = typeof options.angle === "number" ? data.map(() => options.angle) : channelValues(data, options.angle, (_datum, { index }) => index);
        const radiusValues = typeof options.radius === "number" ? data.map(() => options.radius) : channelValues(
          data,
          options.radius,
          (datum) => typeof datum === "number" ? datum : void 0
        );
        const zValues = channelValues(data, options.z, () => null);
        const colorValues = options.color === void 0 ? zValues : channelValues(data, options.color, () => null);
        const groups = options.z === void 0 && options.color !== void 0 ? colorValues : zValues;
        const keys = inferredKeyValues(data, options.key, {
          groups,
          candidates: [angleValues],
          markId: id,
          warningIdentity: options
        });
        return {
          id,
          angleScale,
          radiusScale,
          colorValues: colorValues.filter(isChartKey),
          angleValues: angleValues.filter(isChartValue),
          radiusValues: radiusValues.filter(isChartValue),
          includeZeroRadius: false,
          requiresAngleScale: true,
          requiresRadiusScale: true,
          render: ({ layout, color: resolveColor }) => {
            const angle = requiredPolarScale(
              layout,
              angleScale,
              "angle",
              `Polar mark "${id}"`
            );
            const radius = requiredPolarScale(
              layout,
              radiusScale,
              "radius",
              `Polar mark "${id}"`
            );
            const nodes = [];
            const points = [];
            for (const [groupKey, indices] of groupIndices(groups)) {
              const firstIndex = indices[0];
              if (firstIndex === void 0) continue;
              const group2 = groups[firstIndex] ?? null;
              const stroke = visualValue(
                options.stroke,
                data[firstIndex],
                firstIndex,
                data,
                resolveColor(colorValues[firstIndex] ?? null)
              );
              const rows = indices.map((datumIndex) => ({
                datumIndex,
                angleValue: angleValues[datumIndex],
                radiusValue: radiusValues[datumIndex],
                angle: mapPolarScale(angle, angleValues[datumIndex]),
                radius: mapPolarScale(radius, radiusValues[datumIndex])
              }));
              const generator = lineRadial_default().defined(
                (row) => isFiniteNumber(row.angle) && isFiniteNumber(row.radius)
              ).angle((row) => row.angle).radius((row) => row.radius);
              if (options.curve) generator.curve(options.curve);
              const path2 = generator(rows);
              if (typeof path2 === "string" && path2) {
                nodes.push({
                  kind: "polyline",
                  key: `${id}:${groupKey}`,
                  points: [],
                  path: path2,
                  style: {
                    fill: "none",
                    stroke,
                    strokeOpacity: options.strokeOpacity,
                    strokeWidth: options.strokeWidth ?? 2.25,
                    strokeDasharray: options.strokeDasharray,
                    opacity: options.opacity,
                    lineCap: "round",
                    lineJoin: "round"
                  }
                });
              }
              for (const row of rows) {
                if (!isChartValue(row.angleValue) || !isChartValue(row.radiusValue) || !isFiniteNumber(row.angle) || !isFiniteNumber(row.radius)) {
                  continue;
                }
                const [x2, y2] = pointRadial_default(row.angle, row.radius);
                const key = `${id}:${groupKey}:${valueKey(keys[row.datumIndex])}`;
                const point3 = withPolarFocusGeometry(
                  {
                    key,
                    markId: id,
                    group: group2,
                    groupLabel: group2 == null ? id : String(group2),
                    datum: data[row.datumIndex],
                    datumIndex: row.datumIndex,
                    xValue: row.angleValue,
                    yValue: row.radiusValue,
                    x: layout.centerX + x2,
                    y: layout.centerY + y2,
                    color: stroke
                  },
                  layout,
                  row.angle,
                  row.radius,
                  x2,
                  y2
                );
                points.push(point3);
                if (options.points) {
                  nodes.push({
                    kind: "dot",
                    key: `${key}:dot`,
                    x: x2,
                    y: y2,
                    radius: 2.5,
                    pointOwner: point3,
                    style: { fill: stroke }
                  });
                }
              }
            }
            return {
              nodes: [
                {
                  kind: "group",
                  key: id,
                  className: classes(
                    "ts-chart__radial-line ts-chart__line",
                    options.className
                  ),
                  ariaHidden: true,
                  children: nodes
                }
              ],
              points
            };
          }
        };
      },
      options.motion,
      options.renderer
    );
  }
  function radialArea(source, options = {}) {
    const data = asArray(source);
    return createPolarMark2(
      ({ markIndex, parentId }) => {
        const id = options.id ?? `${parentId}:radial-area-${markIndex}`;
        const angleScale = options.angleScale ?? "angle";
        const radiusScale = options.radiusScale ?? "radius";
        const angleValues = typeof options.angle === "number" ? data.map(() => options.angle) : channelValues(data, options.angle, (_datum, { index }) => index);
        const radiusValues = typeof options.radius === "number" ? data.map(() => options.radius) : channelValues(
          data,
          options.radius,
          (datum) => typeof datum === "number" ? datum : void 0
        );
        const radius1Values = typeof options.radius1 === "number" ? data.map(() => options.radius1) : channelValues(data, options.radius1, () => 0);
        const zValues = channelValues(data, options.z, () => null);
        const colorValues = options.color === void 0 ? zValues : channelValues(data, options.color, () => null);
        const groups = options.z === void 0 && options.color !== void 0 ? colorValues : zValues;
        const keys = inferredKeyValues(data, options.key, {
          groups,
          candidates: [angleValues],
          markId: id,
          warningIdentity: options
        });
        return {
          id,
          angleScale,
          radiusScale,
          colorValues: colorValues.filter(isChartKey),
          angleValues: angleValues.filter(isChartValue),
          radiusValues: [
            ...radiusValues.filter(isChartValue),
            ...radius1Values.filter(isChartValue)
          ],
          includeZeroRadius: options.radius1 === void 0,
          requiresAngleScale: true,
          requiresRadiusScale: true,
          render: ({ layout, color: resolveColor }) => {
            const angle = requiredPolarScale(
              layout,
              angleScale,
              "angle",
              `Polar mark "${id}"`
            );
            const radius = requiredPolarScale(
              layout,
              radiusScale,
              "radius",
              `Polar mark "${id}"`
            );
            const nodes = [];
            const points = [];
            for (const [groupKey, indices] of groupIndices(groups)) {
              const firstIndex = indices[0];
              if (firstIndex === void 0) continue;
              const datum = data[firstIndex];
              const group2 = groups[firstIndex] ?? null;
              const fallback = resolveColor(colorValues[firstIndex] ?? null);
              const fill = visualValue(
                options.fill,
                datum,
                firstIndex,
                data,
                fallback
              );
              const stroke = options.stroke === void 0 ? void 0 : visualValue(options.stroke, datum, firstIndex, data, fallback);
              const rows = indices.map((datumIndex) => ({
                datumIndex,
                angleValue: angleValues[datumIndex],
                radiusValue: radiusValues[datumIndex],
                angle: mapPolarScale(angle, angleValues[datumIndex]),
                radius: mapPolarScale(radius, radiusValues[datumIndex]),
                radius1: mapPolarScale(radius, radius1Values[datumIndex])
              }));
              const generator = areaRadial_default().defined(
                (row) => isFiniteNumber(row.angle) && isFiniteNumber(row.radius) && isFiniteNumber(row.radius1)
              ).angle((row) => row.angle).innerRadius((row) => row.radius1).outerRadius((row) => row.radius);
              if (options.curve) generator.curve(options.curve);
              const path2 = generator(rows);
              if (typeof path2 === "string" && path2) {
                nodes.push({
                  kind: "area",
                  key: `${id}:${groupKey}`,
                  points: [],
                  path: path2,
                  style: {
                    fill,
                    fillOpacity: options.fillOpacity ?? 0.2,
                    stroke,
                    strokeOpacity: options.strokeOpacity,
                    strokeWidth: options.strokeWidth,
                    strokeDasharray: options.strokeDasharray,
                    opacity: options.opacity,
                    lineJoin: "round"
                  }
                });
              }
              for (const row of rows) {
                if (!isChartValue(row.angleValue) || !isChartValue(row.radiusValue) || !isFiniteNumber(row.angle) || !isFiniteNumber(row.radius)) {
                  continue;
                }
                const [x2, y2] = pointRadial_default(row.angle, row.radius);
                const key = `${id}:${groupKey}:${valueKey(keys[row.datumIndex])}`;
                points.push(
                  withPolarFocusGeometry(
                    {
                      key,
                      markId: id,
                      group: group2,
                      groupLabel: group2 == null ? id : String(group2),
                      datum: data[row.datumIndex],
                      datumIndex: row.datumIndex,
                      xValue: row.angleValue,
                      yValue: row.radiusValue,
                      x: layout.centerX + x2,
                      y: layout.centerY + y2,
                      color: fill
                    },
                    layout,
                    row.angle,
                    row.radius,
                    x2,
                    y2
                  )
                );
              }
            }
            return {
              nodes: [
                {
                  kind: "group",
                  key: id,
                  className: classes("ts-chart__radial-area", options.className),
                  ariaHidden: true,
                  children: nodes
                }
              ],
              points
            };
          }
        };
      },
      options.motion,
      options.renderer
    );
  }
  function radialText(source, options = {}) {
    const data = asArray(source);
    return createPolarMark2(
      ({ markIndex, parentId }) => {
        const id = options.id ?? `${parentId}:radial-text-${markIndex}`;
        const angleScale = options.angleScale ?? "angle";
        const radiusScale = options.radiusScale ?? "radius";
        const angleValues = typeof options.angle === "number" ? data.map(() => options.angle) : channelValues(data, options.angle, (_datum, { index }) => index);
        const radiusValues = typeof options.radius === "number" ? data.map(() => options.radius) : channelValues(
          data,
          options.radius,
          (datum) => typeof datum === "number" ? datum : void 0
        );
        const textValues = channelValues(
          data,
          options.text,
          (datum) => datum == null ? "" : String(datum)
        );
        const groups = channelValues(data, options.z, () => null);
        const colorValues = options.color === void 0 ? groups : channelValues(data, options.color, () => null);
        const keys = inferredKeyValues(data, options.key, { groups });
        return {
          id,
          angleScale,
          radiusScale,
          colorValues: colorValues.filter(isChartKey),
          angleValues: angleValues.filter(isChartValue),
          radiusValues: radiusValues.filter(isChartValue),
          includeZeroRadius: false,
          requiresAngleScale: true,
          requiresRadiusScale: true,
          render: ({ layout, color: resolveColor, theme }) => {
            const angle = requiredPolarScale(
              layout,
              angleScale,
              "angle",
              `Polar mark "${id}"`
            );
            const radius = requiredPolarScale(
              layout,
              radiusScale,
              "radius",
              `Polar mark "${id}"`
            );
            const nodes = [];
            const points = [];
            data.forEach((datum, datumIndex) => {
              const angleValue = angleValues[datumIndex];
              const radiusValue = radiusValues[datumIndex];
              const textValue = textValues[datumIndex];
              const anglePosition = mapPolarScale(angle, angleValue);
              const radiusPosition = mapPolarScale(radius, radiusValue);
              if (!isChartValue(angleValue) || !isChartValue(radiusValue) || textValue == null || !isFiniteNumber(anglePosition) || !isFiniteNumber(radiusPosition)) {
                return;
              }
              const radiusOffset = visualValue(
                options.radiusOffset,
                datum,
                datumIndex,
                data,
                0
              );
              const projectedRadius = radiusPosition + radiusOffset;
              if (!isFiniteNumber(radiusOffset) || !isFiniteNumber(projectedRadius)) {
                return;
              }
              const [baseX, baseY] = pointRadial_default(anglePosition, projectedRadius);
              const x2 = baseX + visualValue(options.dx, datum, datumIndex, data, 0);
              const y2 = baseY + visualValue(options.dy, datum, datumIndex, data, 0);
              const group2 = groups[datumIndex] ?? null;
              const colorValue = colorValues[datumIndex] ?? null;
              const fill = visualValue(
                options.fill,
                datum,
                datumIndex,
                data,
                colorValue == null ? theme.foreground : resolveColor(colorValue)
              );
              const key = `${id}:${valueKey(group2)}:${valueKey(keys[datumIndex])}`;
              const authoredAnchor = visualValue(
                options.anchor,
                datum,
                datumIndex,
                data,
                "middle"
              );
              nodes.push({
                kind: "label",
                key,
                x: x2,
                y: y2,
                text: String(textValue),
                anchor: authoredAnchor === "outside" ? outsideRadialAnchor(anglePosition) : authoredAnchor,
                baseline: visualValue(
                  options.baseline,
                  datum,
                  datumIndex,
                  data,
                  "middle"
                ),
                rotate: options.rotate === void 0 ? void 0 : visualValue(options.rotate, datum, datumIndex, data, 0),
                fontSize: options.fontSize,
                fontWeight: options.fontWeight,
                style: { fill }
              });
              points.push(
                withPolarFocusGeometry(
                  {
                    key,
                    markId: id,
                    group: group2,
                    groupLabel: group2 == null ? id : String(group2),
                    datum,
                    datumIndex,
                    xValue: angleValue,
                    yValue: radiusValue,
                    x: layout.centerX + x2,
                    y: layout.centerY + y2,
                    color: fill
                  },
                  layout,
                  anglePosition,
                  projectedRadius,
                  x2,
                  y2
                )
              );
            });
            return {
              nodes: [
                {
                  kind: "group",
                  key: id,
                  className: classes(
                    "ts-chart__radial-text ts-chart__text",
                    options.className
                  ),
                  ariaHidden: true,
                  children: nodes
                }
              ],
              points
            };
          }
        };
      },
      options.motion,
      options.renderer
    );
  }
  function radialGrid(options = {}) {
    return {
      render: ({ layout, theme, guideIndex, parentId }) => {
        const radial = requiredPolarScale(
          layout,
          options.scale ?? "radius",
          "radius",
          "Radial grid"
        );
        const values = options.values ?? radial.ticks(options.ticks ?? 5);
        const stroke = options.stroke ?? theme.grid;
        const rings = [];
        const labels = [];
        for (const [index, value2] of values.entries()) {
          const radius = radial.map(value2);
          if (!isFiniteNumber(radius)) continue;
          let path2;
          if (options.shape === "polygon") {
            const angle = requiredPolarScale(
              layout,
              options.angleScale ?? "angle",
              "angle",
              "Polygon radial grid"
            );
            path2 = polygonRingPath(angle, radius);
          } else {
            path2 = arc_default().innerRadius(0).outerRadius(radius).startAngle(0).endAngle(tau5)(null);
          }
          if (typeof path2 === "string" && path2) {
            rings.push({
              kind: "polyline",
              key: `ring:${valueKey(value2)}`,
              points: [],
              path: path2,
              style: {
                fill: options.fill ?? "none",
                fillOpacity: options.fillOpacity,
                stroke,
                strokeOpacity: options.strokeOpacity,
                strokeWidth: options.strokeWidth ?? 1,
                strokeDasharray: options.strokeDasharray
              }
            });
          }
          if (options.labels) {
            const angle = options.labelAngle ?? layout.startAngle;
            const [x2, y2] = pointRadial_default(angle, radius + (options.labelOffset ?? 0));
            const labelContext = {
              value: value2,
              index,
              angle,
              radius,
              x: x2,
              y: y2,
              layout
            };
            labels.push({
              kind: "label",
              key: `radius-label:${valueKey(value2)}`,
              x: x2 + guideLabelOption(options.labelDx, labelContext, 0),
              y: y2 + guideLabelOption(options.labelDy, labelContext, 0),
              text: options.format?.(value2) ?? String(value2),
              anchor: guideLabelOption(
                options.labelAnchor,
                labelContext,
                "start"
              ),
              baseline: guideLabelOption(
                options.labelBaseline,
                labelContext,
                "middle"
              ),
              rotate: guideLabelOption(options.labelRotate, labelContext, 0),
              fontSize: options.labelFontSize ?? 12,
              style: { fill: options.labelFill ?? theme.muted }
            });
          }
        }
        const id = options.id ?? `${parentId}:radial-grid-${guideIndex}`;
        return {
          background: [
            {
              kind: "group",
              key: id,
              className: classes("ts-chart__radial-grid", options.className),
              ariaHidden: true,
              children: rings
            }
          ],
          foreground: labels.length ? [
            {
              kind: "group",
              key: `${id}:labels`,
              className: classes("ts-chart__text", options.labelClassName),
              ariaHidden: true,
              children: labels
            }
          ] : void 0
        };
      }
    };
  }
  function angleGrid(options = {}) {
    return {
      render: ({ layout, theme, guideIndex, parentId }) => {
        const angle = requiredPolarScale(
          layout,
          options.scale ?? "angle",
          "angle",
          "Angle grid"
        );
        const values = options.values ?? angle.domain;
        const spokes = [];
        const labels = [];
        for (const [index, value2] of values.entries()) {
          const position = angle.map(value2);
          if (!isFiniteNumber(position)) continue;
          const [x2, y2] = pointRadial_default(position, layout.radius);
          spokes.push({
            kind: "rule",
            key: `spoke:${valueKey(value2)}`,
            x1: 0,
            y1: 0,
            x2,
            y2,
            style: {
              stroke: options.stroke ?? theme.grid,
              strokeOpacity: options.strokeOpacity,
              strokeWidth: options.strokeWidth ?? 1,
              strokeDasharray: options.strokeDasharray
            }
          });
          if (options.labels !== false) {
            const [x3, y3] = pointRadial_default(
              position,
              layout.radius + (options.labelOffset ?? 8)
            );
            const labelContext = {
              value: value2,
              index,
              angle: position,
              radius: layout.radius,
              x: x3,
              y: y3,
              layout
            };
            labels.push({
              kind: "label",
              key: `angle-label:${valueKey(value2)}`,
              x: x3 + guideLabelOption(options.labelDx, labelContext, 0),
              y: y3 + guideLabelOption(options.labelDy, labelContext, 0),
              text: options.format?.(value2) ?? String(value2),
              anchor: guideLabelOption(
                options.labelAnchor,
                labelContext,
                outsideRadialAnchor(position)
              ),
              baseline: guideLabelOption(
                options.labelBaseline,
                labelContext,
                Math.abs(y3) < 1 ? "middle" : y3 < 0 ? "auto" : "hanging"
              ),
              rotate: guideLabelOption(options.labelRotate, labelContext, 0),
              fontSize: options.labelFontSize ?? 12,
              style: { fill: options.labelFill ?? theme.muted }
            });
          }
        }
        const id = options.id ?? `${parentId}:angle-grid-${guideIndex}`;
        return {
          background: [
            {
              kind: "group",
              key: id,
              className: classes("ts-chart__angle-grid", options.className),
              ariaHidden: true,
              children: spokes
            }
          ],
          foreground: labels.length ? [
            {
              kind: "group",
              key: `${id}:labels`,
              className: classes("ts-chart__text", options.labelClassName),
              ariaHidden: true,
              children: labels
            }
          ] : void 0
        };
      }
    };
  }
  function resolvePolarLayout(options, chart, marks) {
    const startAngle = finite(options.startAngle, 0);
    const endAngle = finite(options.endAngle, tau5);
    const inset = Math.max(0, finite(options.inset, 0));
    const radiusRatio = Math.max(0, finite(options.radiusRatio, 1));
    const radius = Math.max(0, Math.min(chart.width, chart.height) / 2 - inset) * radiusRatio;
    const sourceScales = resolvePolarScaleOptions(options);
    const scales = {};
    const layout = {
      chart,
      centerX: chart.x + chart.width / 2,
      centerY: chart.y + chart.height / 2,
      radius,
      startAngle,
      endAngle,
      scales
    };
    for (const [id, scaleOptions] of Object.entries(sourceScales)) {
      if (!scaleOptions) continue;
      const reservedChannel = id === "angle" || id === "radius" ? id : void 0;
      const channel = reservedChannel ?? scaleOptions.channel;
      if (!channel) {
        throw new TypeError(
          `Named polar scale "${id}" requires channel: "angle" or channel: "radius"`
        );
      }
      if (scaleOptions.channel && scaleOptions.channel !== channel) {
        throw new TypeError(
          `Polar scale "${id}" is reserved for ${channel} but declares channel: "${scaleOptions.channel}"`
        );
      }
      if (reservedChannel && !marks.some(
        (mark) => reservedChannel === "angle" ? mark.angleScale === id : mark.radiusScale === id
      )) {
        throw new TypeError(
          `Polar scale "${id}" cannot be configured when no mark materializes its channel`
        );
      }
      const valuesKey = channel === "angle" ? "angleValues" : "radiusValues";
      const values = collectPolarValues(marks, valuesKey, id);
      const includeZero = channel === "radius" && marks.some((mark) => mark.radiusScale === id && mark.includeZeroRadius);
      let rangeStart;
      let rangeEnd;
      let wrapPointScale = false;
      if (channel === "angle") {
        rangeStart = startAngle;
        rangeEnd = endAngle;
        wrapPointScale = scaleOptions.wrap ?? isCompleteRevolution(startAngle, endAngle);
      } else {
        const radiusRange = resolvePolarRadiusRange(
          scaleOptions.range,
          layout
        );
        rangeStart = radiusRange[0];
        rangeEnd = radiusRange[1];
      }
      scales[id] = resolvePolarScale(
        id,
        channel,
        scaleOptions.scale,
        values,
        rangeStart,
        rangeEnd,
        wrapPointScale,
        includeZero,
        scaleOptions.nice
      );
    }
    return layout;
  }
  function resolvePolarScaleOptions(options) {
    const scales = options.scales;
    if (!scales || !Object.hasOwn(scales, "angle") || !Object.hasOwn(scales, "radius")) {
      throw new TypeError(
        "Polar scales must define reserved `angle` and `radius` entries"
      );
    }
    return scales;
  }
  function resolvePolarScale(id, channel, source, values, rangeStart, rangeEnd, wrapPointScale, includeZero, nice) {
    const scale = resolveScaleInput(source, {
      values,
      includeZero,
      nice,
      niceCount: 5
    });
    const domain = scale.domain().filter(isChartValue);
    const pointScale = wrapPointScale && typeof scale.bandwidth === "function" && scale.bandwidth() === 0;
    const resolvedEnd = pointScale ? domain.length > 1 ? rangeStart + (rangeEnd - rangeStart) * (domain.length - 1) / domain.length : rangeStart : rangeEnd;
    scale.range([rangeStart, resolvedEnd]);
    const bandwidth = scale.bandwidth?.() ?? 0;
    const map2 = (value2) => {
      const position = scale(value2);
      return typeof position === "number" && Number.isFinite(position) ? position + bandwidth / 2 : Number.NaN;
    };
    return {
      id,
      channel,
      domain,
      map: map2,
      ticks: (count2) => (scale.ticks?.(count2) ?? domain).filter(isChartValue),
      bandwidth
    };
  }
  function collectPolarValues(marks, key, scaleId) {
    const values = [];
    for (const mark of marks) {
      if ((key === "angleValues" ? mark.angleScale : mark.radiusScale) !== scaleId) {
        continue;
      }
      for (const value2 of mark[key]) values.push(value2);
    }
    return values;
  }
  function polygonRingPath(angle, radius) {
    const rows = angle.domain.map((value2) => ({
      angle: angle.map(value2),
      radius
    }));
    return lineRadial_default().angle((row) => row.angle).radius((row) => row.radius).curve(linearClosed_default)(rows) ?? "";
  }
  function createPolarMark2(initialize, motion, renderer) {
    return createPolarMark(
      initialize,
      motion,
      renderer
    );
  }
  function groupIndices(groups) {
    const result = /* @__PURE__ */ new Map();
    groups.forEach((group2, index) => {
      const key = valueKey(group2 ?? null);
      const indices = result.get(key);
      if (indices) indices.push(index);
      else result.set(key, [index]);
    });
    return result;
  }
  function requiredPolarScale(layout, id, channel, owner = "Polar mark") {
    const scale = layout.scales[id];
    if (!scale) {
      throw new TypeError(
        `${owner} requires a configured ${channel} scale "${id}" in polar.scales`
      );
    }
    if (scale.channel !== channel) {
      throw new TypeError(
        `${owner} uses scale "${id}" as ${channel}, but it is configured for ${scale.channel}`
      );
    }
    return scale;
  }
  function mapPolarScale(scale, value2) {
    return isChartValue(value2) ? scale.map(value2) : Number.NaN;
  }
  function resolveLength(value2, context, fallback) {
    const resolved = typeof value2 === "function" ? value2(context) : value2 ?? fallback;
    return isNonnegativeFiniteNumber(resolved) ? resolved : fallback;
  }
  function resolvePolarRadiusRange(range2, layout) {
    if (!range2) return [0, layout.radius];
    if (range2.length !== 2) {
      throw new TypeError("Polar radius range must contain exactly two endpoints");
    }
    const resolved = range2.map(
      (value2) => typeof value2 === "function" ? value2(layout) : value2
    );
    if (!resolved.every(isNonnegativeFiniteNumber)) {
      throw new TypeError(
        "Polar radius range endpoints must be nonnegative finite pixel lengths"
      );
    }
    return [resolved[0], resolved[1]];
  }
  function numberProperty(value2, key) {
    if (!value2 || typeof value2 !== "object") return void 0;
    const property = value2[key];
    return isFiniteNumber(property) ? property : void 0;
  }
  function asArray(source) {
    return Array.isArray(source) ? source : Array.from(source);
  }
  function finite(value2, fallback) {
    return isFiniteNumber(value2) ? value2 : fallback;
  }
  function isCompleteRevolution(startAngle, endAngle) {
    return Math.abs(Math.abs(endAngle - startAngle) - tau5) <= 1e-12;
  }
  function outsideRadialAnchor(angle) {
    const horizontal = Math.sin(angle);
    return Math.abs(horizontal) <= 1e-6 ? "middle" : horizontal < 0 ? "end" : "start";
  }
  function guideLabelOption(option, context, fallback) {
    return typeof option === "function" ? option(context) : option ?? fallback;
  }
  function classes(base, custom2) {
    return custom2 ? `${base} ${custom2}` : base;
  }

  // node_modules/d3-hierarchy/src/hierarchy/count.js
  function count(node) {
    var sum3 = 0, children = node.children, i = children && children.length;
    if (!i) sum3 = 1;
    else while (--i >= 0) sum3 += children[i].value;
    node.value = sum3;
  }
  function count_default() {
    return this.eachAfter(count);
  }

  // node_modules/d3-hierarchy/src/hierarchy/each.js
  function each_default(callback, that) {
    let index = -1;
    for (const node of this) {
      callback.call(that, node, ++index, this);
    }
    return this;
  }

  // node_modules/d3-hierarchy/src/hierarchy/eachBefore.js
  function eachBefore_default(callback, that) {
    var node = this, nodes = [node], children, i, index = -1;
    while (node = nodes.pop()) {
      callback.call(that, node, ++index, this);
      if (children = node.children) {
        for (i = children.length - 1; i >= 0; --i) {
          nodes.push(children[i]);
        }
      }
    }
    return this;
  }

  // node_modules/d3-hierarchy/src/hierarchy/eachAfter.js
  function eachAfter_default(callback, that) {
    var node = this, nodes = [node], next = [], children, i, n, index = -1;
    while (node = nodes.pop()) {
      next.push(node);
      if (children = node.children) {
        for (i = 0, n = children.length; i < n; ++i) {
          nodes.push(children[i]);
        }
      }
    }
    while (node = next.pop()) {
      callback.call(that, node, ++index, this);
    }
    return this;
  }

  // node_modules/d3-hierarchy/src/hierarchy/find.js
  function find_default(callback, that) {
    let index = -1;
    for (const node of this) {
      if (callback.call(that, node, ++index, this)) {
        return node;
      }
    }
  }

  // node_modules/d3-hierarchy/src/hierarchy/sum.js
  function sum_default(value2) {
    return this.eachAfter(function(node) {
      var sum3 = +value2(node.data) || 0, children = node.children, i = children && children.length;
      while (--i >= 0) sum3 += children[i].value;
      node.value = sum3;
    });
  }

  // node_modules/d3-hierarchy/src/hierarchy/sort.js
  function sort_default(compare) {
    return this.eachBefore(function(node) {
      if (node.children) {
        node.children.sort(compare);
      }
    });
  }

  // node_modules/d3-hierarchy/src/hierarchy/path.js
  function path_default(end) {
    var start = this, ancestor = leastCommonAncestor(start, end), nodes = [start];
    while (start !== ancestor) {
      start = start.parent;
      nodes.push(start);
    }
    var k = nodes.length;
    while (end !== ancestor) {
      nodes.splice(k, 0, end);
      end = end.parent;
    }
    return nodes;
  }
  function leastCommonAncestor(a, b) {
    if (a === b) return a;
    var aNodes = a.ancestors(), bNodes = b.ancestors(), c = null;
    a = aNodes.pop();
    b = bNodes.pop();
    while (a === b) {
      c = a;
      a = aNodes.pop();
      b = bNodes.pop();
    }
    return c;
  }

  // node_modules/d3-hierarchy/src/hierarchy/ancestors.js
  function ancestors_default() {
    var node = this, nodes = [node];
    while (node = node.parent) {
      nodes.push(node);
    }
    return nodes;
  }

  // node_modules/d3-hierarchy/src/hierarchy/descendants.js
  function descendants_default() {
    return Array.from(this);
  }

  // node_modules/d3-hierarchy/src/hierarchy/leaves.js
  function leaves_default() {
    var leaves = [];
    this.eachBefore(function(node) {
      if (!node.children) {
        leaves.push(node);
      }
    });
    return leaves;
  }

  // node_modules/d3-hierarchy/src/hierarchy/links.js
  function links_default() {
    var root = this, links = [];
    root.each(function(node) {
      if (node !== root) {
        links.push({ source: node.parent, target: node });
      }
    });
    return links;
  }

  // node_modules/d3-hierarchy/src/hierarchy/iterator.js
  function* iterator_default() {
    var node = this, current, next = [node], children, i, n;
    do {
      current = next.reverse(), next = [];
      while (node = current.pop()) {
        yield node;
        if (children = node.children) {
          for (i = 0, n = children.length; i < n; ++i) {
            next.push(children[i]);
          }
        }
      }
    } while (next.length);
  }

  // node_modules/d3-hierarchy/src/hierarchy/index.js
  function hierarchy(data, children) {
    if (data instanceof Map) {
      data = [void 0, data];
      if (children === void 0) children = mapChildren;
    } else if (children === void 0) {
      children = objectChildren;
    }
    var root = new Node(data), node, nodes = [root], child, childs, i, n;
    while (node = nodes.pop()) {
      if ((childs = children(node.data)) && (n = (childs = Array.from(childs)).length)) {
        node.children = childs;
        for (i = n - 1; i >= 0; --i) {
          nodes.push(child = childs[i] = new Node(childs[i]));
          child.parent = node;
          child.depth = node.depth + 1;
        }
      }
    }
    return root.eachBefore(computeHeight);
  }
  function node_copy() {
    return hierarchy(this).eachBefore(copyData);
  }
  function objectChildren(d) {
    return d.children;
  }
  function mapChildren(d) {
    return Array.isArray(d) ? d[1] : null;
  }
  function copyData(node) {
    if (node.data.value !== void 0) node.value = node.data.value;
    node.data = node.data.data;
  }
  function computeHeight(node) {
    var height = 0;
    do
      node.height = height;
    while ((node = node.parent) && node.height < ++height);
  }
  function Node(data) {
    this.data = data;
    this.depth = this.height = 0;
    this.parent = null;
  }
  Node.prototype = hierarchy.prototype = {
    constructor: Node,
    count: count_default,
    each: each_default,
    eachAfter: eachAfter_default,
    eachBefore: eachBefore_default,
    find: find_default,
    sum: sum_default,
    sort: sort_default,
    path: path_default,
    ancestors: ancestors_default,
    descendants: descendants_default,
    leaves: leaves_default,
    links: links_default,
    copy: node_copy,
    [Symbol.iterator]: iterator_default
  };

  // node_modules/d3-hierarchy/src/accessors.js
  function optional(f) {
    return f == null ? null : required(f);
  }
  function required(f) {
    if (typeof f !== "function") throw new Error();
    return f;
  }

  // node_modules/d3-hierarchy/src/constant.js
  function constantZero() {
    return 0;
  }
  function constant_default2(x2) {
    return function() {
      return x2;
    };
  }

  // node_modules/d3-hierarchy/src/treemap/round.js
  function round_default(node) {
    node.x0 = Math.round(node.x0);
    node.y0 = Math.round(node.y0);
    node.x1 = Math.round(node.x1);
    node.y1 = Math.round(node.y1);
  }

  // node_modules/d3-hierarchy/src/treemap/dice.js
  function dice_default(parent, x0, y0, x1, y1) {
    var nodes = parent.children, node, i = -1, n = nodes.length, k = parent.value && (x1 - x0) / parent.value;
    while (++i < n) {
      node = nodes[i], node.y0 = y0, node.y1 = y1;
      node.x0 = x0, node.x1 = x0 += node.value * k;
    }
  }

  // node_modules/d3-hierarchy/src/stratify.js
  var preroot = { depth: -1 };
  var ambiguous = {};
  var imputed = {};
  function defaultId(d) {
    return d.id;
  }
  function defaultParentId(d) {
    return d.parentId;
  }
  function stratify_default() {
    var id = defaultId, parentId = defaultParentId, path2;
    function stratify(data) {
      var nodes = Array.from(data), currentId = id, currentParentId = parentId, n, d, i, root, parent, node, nodeId, nodeKey, nodeByKey = /* @__PURE__ */ new Map();
      if (path2 != null) {
        const I = nodes.map((d2, i2) => normalize(path2(d2, i2, data)));
        const P = I.map(parentof);
        const S = new Set(I).add("");
        for (const i2 of P) {
          if (!S.has(i2)) {
            S.add(i2);
            I.push(i2);
            P.push(parentof(i2));
            nodes.push(imputed);
          }
        }
        currentId = (_, i2) => I[i2];
        currentParentId = (_, i2) => P[i2];
      }
      for (i = 0, n = nodes.length; i < n; ++i) {
        d = nodes[i], node = nodes[i] = new Node(d);
        if ((nodeId = currentId(d, i, data)) != null && (nodeId += "")) {
          nodeKey = node.id = nodeId;
          nodeByKey.set(nodeKey, nodeByKey.has(nodeKey) ? ambiguous : node);
        }
        if ((nodeId = currentParentId(d, i, data)) != null && (nodeId += "")) {
          node.parent = nodeId;
        }
      }
      for (i = 0; i < n; ++i) {
        node = nodes[i];
        if (nodeId = node.parent) {
          parent = nodeByKey.get(nodeId);
          if (!parent) throw new Error("missing: " + nodeId);
          if (parent === ambiguous) throw new Error("ambiguous: " + nodeId);
          if (parent.children) parent.children.push(node);
          else parent.children = [node];
          node.parent = parent;
        } else {
          if (root) throw new Error("multiple roots");
          root = node;
        }
      }
      if (!root) throw new Error("no root");
      if (path2 != null) {
        while (root.data === imputed && root.children.length === 1) {
          root = root.children[0], --n;
        }
        for (let i2 = nodes.length - 1; i2 >= 0; --i2) {
          node = nodes[i2];
          if (node.data !== imputed) break;
          node.data = null;
        }
      }
      root.parent = preroot;
      root.eachBefore(function(node2) {
        node2.depth = node2.parent.depth + 1;
        --n;
      }).eachBefore(computeHeight);
      root.parent = null;
      if (n > 0) throw new Error("cycle");
      return root;
    }
    stratify.id = function(x2) {
      return arguments.length ? (id = optional(x2), stratify) : id;
    };
    stratify.parentId = function(x2) {
      return arguments.length ? (parentId = optional(x2), stratify) : parentId;
    };
    stratify.path = function(x2) {
      return arguments.length ? (path2 = optional(x2), stratify) : path2;
    };
    return stratify;
  }
  function normalize(path2) {
    path2 = `${path2}`;
    let i = path2.length;
    if (slash(path2, i - 1) && !slash(path2, i - 2)) path2 = path2.slice(0, -1);
    return path2[0] === "/" ? path2 : `/${path2}`;
  }
  function parentof(path2) {
    let i = path2.length;
    if (i < 2) return "";
    while (--i > 1) if (slash(path2, i)) break;
    return path2.slice(0, i);
  }
  function slash(path2, i) {
    if (path2[i] === "/") {
      let k = 0;
      while (i > 0 && path2[--i] === "\\") ++k;
      if ((k & 1) === 0) return true;
    }
    return false;
  }

  // node_modules/d3-hierarchy/src/treemap/slice.js
  function slice_default(parent, x0, y0, x1, y1) {
    var nodes = parent.children, node, i = -1, n = nodes.length, k = parent.value && (y1 - y0) / parent.value;
    while (++i < n) {
      node = nodes[i], node.x0 = x0, node.x1 = x1;
      node.y0 = y0, node.y1 = y0 += node.value * k;
    }
  }

  // node_modules/d3-hierarchy/src/treemap/squarify.js
  var phi = (1 + Math.sqrt(5)) / 2;
  function squarifyRatio(ratio, parent, x0, y0, x1, y1) {
    var rows = [], nodes = parent.children, row, nodeValue, i0 = 0, i1 = 0, n = nodes.length, dx, dy, value2 = parent.value, sumValue, minValue, maxValue, newRatio, minRatio, alpha, beta;
    while (i0 < n) {
      dx = x1 - x0, dy = y1 - y0;
      do
        sumValue = nodes[i1++].value;
      while (!sumValue && i1 < n);
      minValue = maxValue = sumValue;
      alpha = Math.max(dy / dx, dx / dy) / (value2 * ratio);
      beta = sumValue * sumValue * alpha;
      minRatio = Math.max(maxValue / beta, beta / minValue);
      for (; i1 < n; ++i1) {
        sumValue += nodeValue = nodes[i1].value;
        if (nodeValue < minValue) minValue = nodeValue;
        if (nodeValue > maxValue) maxValue = nodeValue;
        beta = sumValue * sumValue * alpha;
        newRatio = Math.max(maxValue / beta, beta / minValue);
        if (newRatio > minRatio) {
          sumValue -= nodeValue;
          break;
        }
        minRatio = newRatio;
      }
      rows.push(row = { value: sumValue, dice: dx < dy, children: nodes.slice(i0, i1) });
      if (row.dice) dice_default(row, x0, y0, x1, value2 ? y0 += dy * sumValue / value2 : y1);
      else slice_default(row, x0, y0, value2 ? x0 += dx * sumValue / value2 : x1, y1);
      value2 -= sumValue, i0 = i1;
    }
    return rows;
  }
  var squarify_default = (function custom(ratio) {
    function squarify(parent, x0, y0, x1, y1) {
      squarifyRatio(ratio, parent, x0, y0, x1, y1);
    }
    squarify.ratio = function(x2) {
      return custom((x2 = +x2) > 1 ? x2 : 1);
    };
    return squarify;
  })(phi);

  // node_modules/d3-hierarchy/src/treemap/index.js
  function treemap_default() {
    var tile = squarify_default, round = false, dx = 1, dy = 1, paddingStack = [0], paddingInner = constantZero, paddingTop = constantZero, paddingRight = constantZero, paddingBottom = constantZero, paddingLeft = constantZero;
    function treemap2(root) {
      root.x0 = root.y0 = 0;
      root.x1 = dx;
      root.y1 = dy;
      root.eachBefore(positionNode);
      paddingStack = [0];
      if (round) root.eachBefore(round_default);
      return root;
    }
    function positionNode(node) {
      var p = paddingStack[node.depth], x0 = node.x0 + p, y0 = node.y0 + p, x1 = node.x1 - p, y1 = node.y1 - p;
      if (x1 < x0) x0 = x1 = (x0 + x1) / 2;
      if (y1 < y0) y0 = y1 = (y0 + y1) / 2;
      node.x0 = x0;
      node.y0 = y0;
      node.x1 = x1;
      node.y1 = y1;
      if (node.children) {
        p = paddingStack[node.depth + 1] = paddingInner(node) / 2;
        x0 += paddingLeft(node) - p;
        y0 += paddingTop(node) - p;
        x1 -= paddingRight(node) - p;
        y1 -= paddingBottom(node) - p;
        if (x1 < x0) x0 = x1 = (x0 + x1) / 2;
        if (y1 < y0) y0 = y1 = (y0 + y1) / 2;
        tile(node, x0, y0, x1, y1);
      }
    }
    treemap2.round = function(x2) {
      return arguments.length ? (round = !!x2, treemap2) : round;
    };
    treemap2.size = function(x2) {
      return arguments.length ? (dx = +x2[0], dy = +x2[1], treemap2) : [dx, dy];
    };
    treemap2.tile = function(x2) {
      return arguments.length ? (tile = required(x2), treemap2) : tile;
    };
    treemap2.padding = function(x2) {
      return arguments.length ? treemap2.paddingInner(x2).paddingOuter(x2) : treemap2.paddingInner();
    };
    treemap2.paddingInner = function(x2) {
      return arguments.length ? (paddingInner = typeof x2 === "function" ? x2 : constant_default2(+x2), treemap2) : paddingInner;
    };
    treemap2.paddingOuter = function(x2) {
      return arguments.length ? treemap2.paddingTop(x2).paddingRight(x2).paddingBottom(x2).paddingLeft(x2) : treemap2.paddingTop();
    };
    treemap2.paddingTop = function(x2) {
      return arguments.length ? (paddingTop = typeof x2 === "function" ? x2 : constant_default2(+x2), treemap2) : paddingTop;
    };
    treemap2.paddingRight = function(x2) {
      return arguments.length ? (paddingRight = typeof x2 === "function" ? x2 : constant_default2(+x2), treemap2) : paddingRight;
    };
    treemap2.paddingBottom = function(x2) {
      return arguments.length ? (paddingBottom = typeof x2 === "function" ? x2 : constant_default2(+x2), treemap2) : paddingBottom;
    };
    treemap2.paddingLeft = function(x2) {
      return arguments.length ? (paddingLeft = typeof x2 === "function" ? x2 : constant_default2(+x2), treemap2) : paddingLeft;
    };
    return treemap2;
  }

  // node_modules/d3-hierarchy/src/treemap/binary.js
  function binary_default(parent, x0, y0, x1, y1) {
    var nodes = parent.children, i, n = nodes.length, sum3, sums = new Array(n + 1);
    for (sums[0] = sum3 = i = 0; i < n; ++i) {
      sums[i + 1] = sum3 += nodes[i].value;
    }
    partition(0, n, parent.value, x0, y0, x1, y1);
    function partition(i2, j, value2, x02, y02, x12, y12) {
      if (i2 >= j - 1) {
        var node = nodes[i2];
        node.x0 = x02, node.y0 = y02;
        node.x1 = x12, node.y1 = y12;
        return;
      }
      var valueOffset = sums[i2], valueTarget = value2 / 2 + valueOffset, k = i2 + 1, hi = j - 1;
      while (k < hi) {
        var mid = k + hi >>> 1;
        if (sums[mid] < valueTarget) k = mid + 1;
        else hi = mid;
      }
      if (valueTarget - sums[k - 1] < sums[k] - valueTarget && i2 + 1 < k) --k;
      var valueLeft = sums[k] - valueOffset, valueRight = value2 - valueLeft;
      if (x12 - x02 > y12 - y02) {
        var xk = value2 ? (x02 * valueRight + x12 * valueLeft) / value2 : x12;
        partition(i2, k, valueLeft, x02, y02, xk, y12);
        partition(k, j, valueRight, xk, y02, x12, y12);
      } else {
        var yk = value2 ? (y02 * valueRight + y12 * valueLeft) / value2 : y12;
        partition(i2, k, valueLeft, x02, y02, x12, yk);
        partition(k, j, valueRight, x02, yk, x12, y12);
      }
    }
  }

  // node_modules/d3-hierarchy/src/treemap/sliceDice.js
  function sliceDice_default(parent, x0, y0, x1, y1) {
    (parent.depth & 1 ? slice_default : dice_default)(parent, x0, y0, x1, y1);
  }

  // node_modules/@tanstack/charts/dist/hierarchy-flat-internal.js
  function buildFlatHierarchy(source, options, owner) {
    const data = toArray(source);
    const sourceRows = data.map((datum, index) => ({ datum, index }));
    const pathMode = options.path !== void 0;
    let root;
    try {
      if (pathMode) {
        const normalize2 = pathNormalizer(options.delimiter, owner);
        const paths = transformValues(data, options.path).map((path2, index) => {
          if (typeof path2 !== "string" || path2.length === 0) {
            throw new TypeError(
              `${owner}: path at index ${index} must be a nonempty string`
            );
          }
          return normalize2(path2);
        });
        assertUnique(paths, "path", owner);
        root = stratify_default().path(
          (row) => paths[row.index]
        )(sourceRows);
      } else {
        const parentOptions = options;
        const ids = transformValues(data, parentOptions.id);
        const parentIds = transformValues(data, parentOptions.parentId);
        ids.forEach((id, index) => assertId(id, `id at index ${index}`, owner));
        assertUnique(ids, "id", owner);
        parentIds.forEach((id, index) => {
          if (id != null) assertId(id, `parentId at index ${index}`, owner);
        });
        root = stratify_default().id((row) => ids[row.index]).parentId((row) => parentIds[row.index] ?? void 0)(
          sourceRows
        );
      }
    } catch (error) {
      if (error instanceof TypeError && error.message.startsWith(`${owner}:`)) {
        throw error;
      }
      throw new TypeError(
        `${owner}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const hierarchyIds = /* @__PURE__ */ new Set();
    for (const node of root.descendants()) {
      const id = node.id;
      if (id === void 0) {
        throw new TypeError(`${owner}: hierarchy node is missing an id`);
      }
      if (hierarchyIds.has(id)) {
        throw new TypeError(`${owner}: duplicate hierarchy id "${id}"`);
      }
      hierarchyIds.add(id);
      const sourceRow = node.data;
      node.data = {
        id,
        parentId: node.parent?.id ?? null,
        name: pathMode ? pathName(id) : id,
        datum: sourceRow === null ? null : sourceRow.datum,
        sourceIndex: sourceRow?.index ?? null
      };
    }
    return {
      data,
      root
    };
  }
  function flatHierarchyNodeContext(node) {
    const { datum, id, name, parentId, sourceIndex } = node.data;
    const source = Object.freeze(
      sourceIndex === null ? [] : [datum]
    );
    const sourceIndexes = Object.freeze(
      sourceIndex === null ? [] : [sourceIndex]
    );
    return {
      id,
      parentId,
      name,
      data: datum,
      depth: node.depth,
      height: node.height,
      internal: node.children !== void 0,
      external: node.children === void 0,
      source,
      sourceIndexes
    };
  }
  function aggregateFlatHierarchyValues(hierarchy2, value2, owner) {
    const values = transformValues(hierarchy2.data, value2).map(
      (resolved, index) => {
        if (resolved == null) return 0;
        assertNonnegativeFinite3(resolved, `value at index ${index}`, owner);
        return resolved;
      }
    );
    hierarchy2.root.sum(
      ({ sourceIndex }) => sourceIndex === null ? 0 : values[sourceIndex]
    );
    for (const node of hierarchy2.root.descendants()) {
      assertNonnegativeFinite3(
        node.value,
        `aggregate value for node "${node.data.id}"`,
        owner
      );
    }
  }
  function flatHierarchyAncestorIds(node) {
    const ids = [];
    let parent = node.parent;
    while (parent) {
      ids.push(parent.data.id);
      parent = parent.parent;
    }
    ids.reverse();
    return Object.freeze(ids);
  }
  function flatHierarchyNodeValue(node) {
    return Number.isFinite(node.value) ? node.value : 0;
  }
  function assertUnique(values, description, owner) {
    const indexes = /* @__PURE__ */ new Map();
    values.forEach((value2, index) => {
      const previous = indexes.get(value2);
      if (previous !== void 0) {
        throw new TypeError(
          `${owner}: duplicate ${description} "${value2}" at indexes ${previous} and ${index}`
        );
      }
      indexes.set(value2, index);
    });
  }
  function assertId(value2, description, owner) {
    if (typeof value2 !== "string" || value2.length === 0) {
      throw new TypeError(`${owner}: ${description} must be a nonempty string`);
    }
  }
  function assertNonnegativeFinite3(value2, description, owner) {
    if (typeof value2 !== "number" || !Number.isFinite(value2) || value2 < 0) {
      throw new TypeError(
        `${owner}: ${description} must be nonnegative and finite`
      );
    }
  }
  function pathNormalizer(delimiter = "/", owner) {
    if (typeof delimiter !== "string" || delimiter.length !== 1) {
      throw new TypeError(`${owner}: delimiter must be exactly one character`);
    }
    if (delimiter === "\\") {
      throw new TypeError(`${owner}: delimiter cannot be backslash`);
    }
    if (delimiter === "/") return (path2) => path2;
    const delimiterCode = delimiter.charCodeAt(0);
    return (path2) => slashDelimiter(path2, delimiterCode);
  }
  var backslashCode = 92;
  var slashCode = 47;
  function slashDelimiter(input, delimiterCode) {
    let afterBackslash = false;
    for (let index = 0, length = input.length; index < length; index += 1) {
      switch (input.charCodeAt(index)) {
        case backslashCode:
          if (!afterBackslash) {
            afterBackslash = true;
            continue;
          }
          break;
        case delimiterCode:
          if (afterBackslash) {
            input = input.slice(0, index - 1) + input.slice(index);
            index -= 1;
            length -= 1;
          } else {
            input = `${input.slice(0, index)}/${input.slice(index + 1)}`;
          }
          break;
        case slashCode:
          if (afterBackslash) {
            input = `${input.slice(0, index)}\\\\${input.slice(index)}`;
            index += 2;
            length += 2;
          } else {
            input = `${input.slice(0, index)}\\${input.slice(index)}`;
            index += 1;
            length += 1;
          }
          break;
      }
      afterBackslash = false;
    }
    return input;
  }
  function pathName(path2) {
    let index = path2.length;
    while (--index > 0) {
      if (isPathSlash(path2, index)) break;
    }
    return unescapePath(path2.slice(index + 1));
  }
  function isPathSlash(path2, index) {
    if (path2[index] !== "/") return false;
    let escapes = 0;
    while (index > 0 && path2[--index] === "\\") escapes += 1;
    return escapes % 2 === 0;
  }
  function unescapePath(input) {
    let afterBackslash = false;
    for (let index = 0, length = input.length; index < length; index += 1) {
      const code = input.charCodeAt(index);
      if (code === backslashCode && !afterBackslash) {
        afterBackslash = true;
        continue;
      }
      if ((code === backslashCode || code === slashCode) && afterBackslash) {
        input = input.slice(0, index - 1) + input.slice(index);
        index -= 1;
        length -= 1;
      }
      afterBackslash = false;
    }
    return input;
  }

  // node_modules/@tanstack/charts/dist/hierarchy-treemap.js
  function treemap(source, options) {
    const hierarchyOptions = options.path !== void 0 ? { path: options.path, delimiter: options.delimiter } : {
      id: options.nodeId,
      parentId: options.parentId
    };
    const hierarchy2 = buildFlatHierarchy(source, hierarchyOptions, "treemap");
    aggregateFlatHierarchyValues(hierarchy2, options.value, "treemap");
    const contexts = /* @__PURE__ */ new WeakMap();
    const context = (node) => {
      const existing = contexts.get(node);
      if (existing) return existing;
      const created = Object.freeze(treemapNodeContext(node));
      contexts.set(node, created);
      return created;
    };
    if (options.sort) {
      hierarchy2.root.sort((left2, right2) => {
        const compared = options.sort(
          context(left2),
          context(right2)
        );
        if (!Number.isFinite(compared)) {
          throw new TypeError("treemap: sort result must be finite");
        }
        return compared;
      });
    }
    const method = options.method ?? "squarify";
    const ratio = options.ratio ?? (1 + Math.sqrt(5)) / 2;
    assertMethod(method);
    if (options.ratio !== void 0 && method !== "squarify") {
      throw new TypeError('treemap: ratio is only valid with method "squarify"');
    }
    if (!Number.isFinite(ratio) || ratio < 1) {
      throw new TypeError("treemap: ratio must be finite and at least 1");
    }
    const paddingInner = options.paddingInner ?? 0;
    const paddingOuter = options.paddingOuter ?? 0;
    assertNonnegativeFinite4(paddingInner, "paddingInner");
    assertNonnegativeFinite4(paddingOuter, "paddingOuter");
    const inset = options.inset ?? 0.75;
    const labelPadding = options.labelPadding ?? 4;
    assertNonnegativeFinite4(inset, "inset");
    assertNonnegativeFinite4(labelPadding, "labelPadding");
    return createMarkWithScaleValues(
      ({ markIndex }) => {
        const id = options.id ?? `treemap-${markIndex}`;
        return {
          id,
          channels: {},
          seriesFromColor: options.color !== void 0,
          resolveLayout: ({ chart, layout }) => {
            const root = hierarchy2.root.copy();
            const laidOut = configureLayout(
              treemap_default(),
              chart.width,
              chart.height,
              method,
              ratio,
              options.round ?? false,
              paddingInner,
              paddingOuter
            )(root);
            const leaves = laidOut.leaves();
            assertLayoutCoordinates(leaves, chart.width, chart.height);
            const cells = leaves.map((node) => materializeCell(node, chart.x, chart.y)).filter((cell2) => cell2.x1 > cell2.x0 && cell2.y1 > cell2.y0);
            const nodes = cells.map((cell2) => cell2.node);
            const colorValues = channelValues(nodes, options.color, () => null);
            const labels = materializeLabels(
              cells,
              options.label,
              options.labelFontSize ?? 11,
              options.labelFontWeight,
              inset,
              labelPadding,
              layout.measureText,
              id
            );
            return {
              channels: {
                color: {
                  scale: "color",
                  values: colorValues.filter(isChartKey)
                }
              },
              states: markStates(nodes, options.states),
              render: ({ color: resolveColor, theme }) => {
                const points = [];
                const children = [];
                cells.forEach((cell2, nodeIndex) => {
                  const node = cell2.node;
                  const colorValue = colorValues[nodeIndex];
                  const fallback = resolveColor(
                    isChartKey(colorValue) ? colorValue : null
                  );
                  const fill = visualValue(
                    options.fill,
                    node,
                    nodeIndex,
                    nodes,
                    fallback
                  );
                  const key = `${id}:node:${valueKey(node.id)}`;
                  const group2 = isChartKey(colorValue) ? colorValue : null;
                  const point3 = {
                    key,
                    markId: id,
                    group: group2,
                    groupLabel: group2 === null ? id : String(group2),
                    datum: node,
                    datumIndex: nodeIndex,
                    xValue: node.id,
                    yValue: node.value,
                    x: cell2.x,
                    y: cell2.y,
                    color: fill
                  };
                  points.push(point3);
                  children.push({
                    kind: "rect",
                    key,
                    x: cell2.x0 + inset,
                    y: cell2.y0 + inset,
                    width: Math.max(0, cell2.x1 - cell2.x0 - inset * 2),
                    height: Math.max(0, cell2.y1 - cell2.y0 - inset * 2),
                    radius: options.radius,
                    inset,
                    insetAxis: "xy",
                    interaction: { point: point3 },
                    style: {
                      fill,
                      fillOpacity: options.fillOpacity,
                      stroke: options.stroke === void 0 ? void 0 : visualValue(
                        options.stroke,
                        node,
                        nodeIndex,
                        nodes,
                        fallback
                      ),
                      strokeOpacity: options.strokeOpacity,
                      strokeWidth: options.strokeWidth
                    }
                  });
                  const label = labels.get(node.id);
                  if (label) {
                    children.push({
                      ...label,
                      key: `${key}:label`,
                      pointOwner: point3,
                      style: {
                        fill: visualValue(
                          options.labelFill,
                          node,
                          nodeIndex,
                          nodes,
                          theme.foreground
                        )
                      }
                    });
                  }
                });
                return {
                  nodes: [
                    {
                      kind: "group",
                      key: id,
                      className: "ts-chart__treemap ts-chart__rect ts-chart__text",
                      ariaHidden: true,
                      children
                    }
                  ],
                  points
                };
              }
            };
          }
        };
      },
      options.motion,
      options.renderer
    );
  }
  function configureLayout(layout, width, height, method, ratio, round, paddingInner, paddingOuter) {
    const tile = typeof method === "function" ? method : method === "squarify" ? squarify_default.ratio(ratio) : method === "binary" ? binary_default : method === "dice" ? dice_default : method === "slice" ? slice_default : sliceDice_default;
    return layout.size([width, height]).tile(tile).round(round).paddingInner(paddingInner).paddingOuter(paddingOuter);
  }
  function treemapNodeContext(node) {
    return {
      ...flatHierarchyNodeContext(node),
      ancestorIds: flatHierarchyAncestorIds(node),
      value: flatHierarchyNodeValue(node)
    };
  }
  function materializeCell(node, offsetX, offsetY) {
    const x0 = offsetX + node.x0;
    const y0 = offsetY + node.y0;
    const x1 = offsetX + node.x1;
    const y1 = offsetY + node.y1;
    return {
      node: treemapNodeContext(node),
      x0,
      y0,
      x1,
      y1,
      x: (x0 + x1) / 2,
      y: (y0 + y1) / 2
    };
  }
  function assertLayoutCoordinates(nodes, width, height) {
    nodes.forEach((node) => {
      const coordinates = [node.x0, node.y0, node.x1, node.y1];
      if (!coordinates.every(Number.isFinite)) {
        throw new TypeError(
          `treemap: layout produced non-finite coordinates for node "${node.data.id}"`
        );
      }
      if (node.x1 < node.x0 || node.y1 < node.y0) {
        throw new TypeError(
          `treemap: layout produced reversed coordinates for node "${node.data.id}"`
        );
      }
      if (node.x0 < 0 || node.y0 < 0 || node.x1 > width || node.y1 > height) {
        throw new TypeError(
          `treemap: layout produced out-of-bounds coordinates for node "${node.data.id}"`
        );
      }
    });
  }
  function materializeLabels(cells, channel, fontSize, fontWeight, inset, padding, measureText, id) {
    if (channel === void 0) return /* @__PURE__ */ new Map();
    const nodes = cells.map((cell2) => cell2.node);
    const values = channelValues(nodes, channel, () => null);
    const labels = /* @__PURE__ */ new Map();
    cells.forEach((cell2, index) => {
      const node = cell2.node;
      const value2 = values[index];
      if (value2 == null || String(value2).length === 0) return;
      const label = {
        kind: "label",
        key: `${id}:label:${valueKey(node.id)}`,
        x: cell2.x,
        y: cell2.y,
        text: String(value2),
        anchor: "middle",
        baseline: "middle",
        fontSize,
        fontWeight
      };
      const bounds = measureSceneLabelBounds(label, measureText);
      const left2 = cell2.x0 + inset + padding;
      const right2 = cell2.x1 - inset - padding;
      const top = cell2.y0 + inset + padding;
      const bottom = cell2.y1 - inset - padding;
      if (bounds.x >= left2 && bounds.x + bounds.width <= right2 && bounds.y >= top && bounds.y + bounds.height <= bottom) {
        labels.set(node.id, label);
      }
    });
    return labels;
  }
  function assertMethod(value2) {
    if (typeof value2 === "function") return;
    if (value2 !== "squarify" && value2 !== "binary" && value2 !== "dice" && value2 !== "slice" && value2 !== "slice-dice") {
      throw new TypeError(`treemap: invalid method "${value2}"`);
    }
  }
  function assertNonnegativeFinite4(value2, description) {
    if (typeof value2 !== "number" || !Number.isFinite(value2) || value2 < 0) {
      throw new TypeError(
        `treemap: ${description} must be nonnegative and finite`
      );
    }
  }

  // node_modules/d3-sankey/node_modules/d3-array/src/max.js
  function max2(values, valueof) {
    let max3;
    if (valueof === void 0) {
      for (const value2 of values) {
        if (value2 != null && (max3 < value2 || max3 === void 0 && value2 >= value2)) {
          max3 = value2;
        }
      }
    } else {
      let index = -1;
      for (let value2 of values) {
        if ((value2 = valueof(value2, ++index, values)) != null && (max3 < value2 || max3 === void 0 && value2 >= value2)) {
          max3 = value2;
        }
      }
    }
    return max3;
  }

  // node_modules/d3-sankey/node_modules/d3-array/src/min.js
  function min2(values, valueof) {
    let min3;
    if (valueof === void 0) {
      for (const value2 of values) {
        if (value2 != null && (min3 > value2 || min3 === void 0 && value2 >= value2)) {
          min3 = value2;
        }
      }
    } else {
      let index = -1;
      for (let value2 of values) {
        if ((value2 = valueof(value2, ++index, values)) != null && (min3 > value2 || min3 === void 0 && value2 >= value2)) {
          min3 = value2;
        }
      }
    }
    return min3;
  }

  // node_modules/d3-sankey/node_modules/d3-array/src/sum.js
  function sum2(values, valueof) {
    let sum3 = 0;
    if (valueof === void 0) {
      for (let value2 of values) {
        if (value2 = +value2) {
          sum3 += value2;
        }
      }
    } else {
      let index = -1;
      for (let value2 of values) {
        if (value2 = +valueof(value2, ++index, values)) {
          sum3 += value2;
        }
      }
    }
    return sum3;
  }

  // node_modules/d3-sankey/src/align.js
  function targetDepth(d) {
    return d.target.depth;
  }
  function left(node) {
    return node.depth;
  }
  function right(node, n) {
    return n - 1 - node.height;
  }
  function justify(node, n) {
    return node.sourceLinks.length ? node.depth : n - 1;
  }
  function center(node) {
    return node.targetLinks.length ? node.depth : node.sourceLinks.length ? min2(node.sourceLinks, targetDepth) - 1 : 0;
  }

  // node_modules/d3-sankey/src/constant.js
  function constant(x2) {
    return function() {
      return x2;
    };
  }

  // node_modules/d3-sankey/src/sankey.js
  function ascendingSourceBreadth(a, b) {
    return ascendingBreadth(a.source, b.source) || a.index - b.index;
  }
  function ascendingTargetBreadth(a, b) {
    return ascendingBreadth(a.target, b.target) || a.index - b.index;
  }
  function ascendingBreadth(a, b) {
    return a.y0 - b.y0;
  }
  function value(d) {
    return d.value;
  }
  function defaultId2(d) {
    return d.index;
  }
  function defaultNodes(graph) {
    return graph.nodes;
  }
  function defaultLinks(graph) {
    return graph.links;
  }
  function find(nodeById, id) {
    const node = nodeById.get(id);
    if (!node) throw new Error("missing: " + id);
    return node;
  }
  function computeLinkBreadths({ nodes }) {
    for (const node of nodes) {
      let y0 = node.y0;
      let y1 = y0;
      for (const link2 of node.sourceLinks) {
        link2.y0 = y0 + link2.width / 2;
        y0 += link2.width;
      }
      for (const link2 of node.targetLinks) {
        link2.y1 = y1 + link2.width / 2;
        y1 += link2.width;
      }
    }
  }
  function Sankey() {
    let x0 = 0, y0 = 0, x1 = 1, y1 = 1;
    let dx = 24;
    let dy = 8, py;
    let id = defaultId2;
    let align = justify;
    let sort;
    let linkSort;
    let nodes = defaultNodes;
    let links = defaultLinks;
    let iterations = 6;
    function sankey() {
      const graph = { nodes: nodes.apply(null, arguments), links: links.apply(null, arguments) };
      computeNodeLinks(graph);
      computeNodeValues(graph);
      computeNodeDepths(graph);
      computeNodeHeights(graph);
      computeNodeBreadths(graph);
      computeLinkBreadths(graph);
      return graph;
    }
    sankey.update = function(graph) {
      computeLinkBreadths(graph);
      return graph;
    };
    sankey.nodeId = function(_) {
      return arguments.length ? (id = typeof _ === "function" ? _ : constant(_), sankey) : id;
    };
    sankey.nodeAlign = function(_) {
      return arguments.length ? (align = typeof _ === "function" ? _ : constant(_), sankey) : align;
    };
    sankey.nodeSort = function(_) {
      return arguments.length ? (sort = _, sankey) : sort;
    };
    sankey.nodeWidth = function(_) {
      return arguments.length ? (dx = +_, sankey) : dx;
    };
    sankey.nodePadding = function(_) {
      return arguments.length ? (dy = py = +_, sankey) : dy;
    };
    sankey.nodes = function(_) {
      return arguments.length ? (nodes = typeof _ === "function" ? _ : constant(_), sankey) : nodes;
    };
    sankey.links = function(_) {
      return arguments.length ? (links = typeof _ === "function" ? _ : constant(_), sankey) : links;
    };
    sankey.linkSort = function(_) {
      return arguments.length ? (linkSort = _, sankey) : linkSort;
    };
    sankey.size = function(_) {
      return arguments.length ? (x0 = y0 = 0, x1 = +_[0], y1 = +_[1], sankey) : [x1 - x0, y1 - y0];
    };
    sankey.extent = function(_) {
      return arguments.length ? (x0 = +_[0][0], x1 = +_[1][0], y0 = +_[0][1], y1 = +_[1][1], sankey) : [[x0, y0], [x1, y1]];
    };
    sankey.iterations = function(_) {
      return arguments.length ? (iterations = +_, sankey) : iterations;
    };
    function computeNodeLinks({ nodes: nodes2, links: links2 }) {
      for (const [i, node] of nodes2.entries()) {
        node.index = i;
        node.sourceLinks = [];
        node.targetLinks = [];
      }
      const nodeById = new Map(nodes2.map((d, i) => [id(d, i, nodes2), d]));
      for (const [i, link2] of links2.entries()) {
        link2.index = i;
        let { source, target } = link2;
        if (typeof source !== "object") source = link2.source = find(nodeById, source);
        if (typeof target !== "object") target = link2.target = find(nodeById, target);
        source.sourceLinks.push(link2);
        target.targetLinks.push(link2);
      }
      if (linkSort != null) {
        for (const { sourceLinks, targetLinks } of nodes2) {
          sourceLinks.sort(linkSort);
          targetLinks.sort(linkSort);
        }
      }
    }
    function computeNodeValues({ nodes: nodes2 }) {
      for (const node of nodes2) {
        node.value = node.fixedValue === void 0 ? Math.max(sum2(node.sourceLinks, value), sum2(node.targetLinks, value)) : node.fixedValue;
      }
    }
    function computeNodeDepths({ nodes: nodes2 }) {
      const n = nodes2.length;
      let current = new Set(nodes2);
      let next = /* @__PURE__ */ new Set();
      let x2 = 0;
      while (current.size) {
        for (const node of current) {
          node.depth = x2;
          for (const { target } of node.sourceLinks) {
            next.add(target);
          }
        }
        if (++x2 > n) throw new Error("circular link");
        current = next;
        next = /* @__PURE__ */ new Set();
      }
    }
    function computeNodeHeights({ nodes: nodes2 }) {
      const n = nodes2.length;
      let current = new Set(nodes2);
      let next = /* @__PURE__ */ new Set();
      let x2 = 0;
      while (current.size) {
        for (const node of current) {
          node.height = x2;
          for (const { source } of node.targetLinks) {
            next.add(source);
          }
        }
        if (++x2 > n) throw new Error("circular link");
        current = next;
        next = /* @__PURE__ */ new Set();
      }
    }
    function computeNodeLayers({ nodes: nodes2 }) {
      const x2 = max2(nodes2, (d) => d.depth) + 1;
      const kx = (x1 - x0 - dx) / (x2 - 1);
      const columns = new Array(x2);
      for (const node of nodes2) {
        const i = Math.max(0, Math.min(x2 - 1, Math.floor(align.call(null, node, x2))));
        node.layer = i;
        node.x0 = x0 + i * kx;
        node.x1 = node.x0 + dx;
        if (columns[i]) columns[i].push(node);
        else columns[i] = [node];
      }
      if (sort) for (const column of columns) {
        column.sort(sort);
      }
      return columns;
    }
    function initializeNodeBreadths(columns) {
      const ky = min2(columns, (c) => (y1 - y0 - (c.length - 1) * py) / sum2(c, value));
      for (const nodes2 of columns) {
        let y2 = y0;
        for (const node of nodes2) {
          node.y0 = y2;
          node.y1 = y2 + node.value * ky;
          y2 = node.y1 + py;
          for (const link2 of node.sourceLinks) {
            link2.width = link2.value * ky;
          }
        }
        y2 = (y1 - y2 + py) / (nodes2.length + 1);
        for (let i = 0; i < nodes2.length; ++i) {
          const node = nodes2[i];
          node.y0 += y2 * (i + 1);
          node.y1 += y2 * (i + 1);
        }
        reorderLinks(nodes2);
      }
    }
    function computeNodeBreadths(graph) {
      const columns = computeNodeLayers(graph);
      py = Math.min(dy, (y1 - y0) / (max2(columns, (c) => c.length) - 1));
      initializeNodeBreadths(columns);
      for (let i = 0; i < iterations; ++i) {
        const alpha = Math.pow(0.99, i);
        const beta = Math.max(1 - alpha, (i + 1) / iterations);
        relaxRightToLeft(columns, alpha, beta);
        relaxLeftToRight(columns, alpha, beta);
      }
    }
    function relaxLeftToRight(columns, alpha, beta) {
      for (let i = 1, n = columns.length; i < n; ++i) {
        const column = columns[i];
        for (const target of column) {
          let y2 = 0;
          let w = 0;
          for (const { source, value: value2 } of target.targetLinks) {
            let v = value2 * (target.layer - source.layer);
            y2 += targetTop(source, target) * v;
            w += v;
          }
          if (!(w > 0)) continue;
          let dy2 = (y2 / w - target.y0) * alpha;
          target.y0 += dy2;
          target.y1 += dy2;
          reorderNodeLinks(target);
        }
        if (sort === void 0) column.sort(ascendingBreadth);
        resolveCollisions(column, beta);
      }
    }
    function relaxRightToLeft(columns, alpha, beta) {
      for (let n = columns.length, i = n - 2; i >= 0; --i) {
        const column = columns[i];
        for (const source of column) {
          let y2 = 0;
          let w = 0;
          for (const { target, value: value2 } of source.sourceLinks) {
            let v = value2 * (target.layer - source.layer);
            y2 += sourceTop(source, target) * v;
            w += v;
          }
          if (!(w > 0)) continue;
          let dy2 = (y2 / w - source.y0) * alpha;
          source.y0 += dy2;
          source.y1 += dy2;
          reorderNodeLinks(source);
        }
        if (sort === void 0) column.sort(ascendingBreadth);
        resolveCollisions(column, beta);
      }
    }
    function resolveCollisions(nodes2, alpha) {
      const i = nodes2.length >> 1;
      const subject = nodes2[i];
      resolveCollisionsBottomToTop(nodes2, subject.y0 - py, i - 1, alpha);
      resolveCollisionsTopToBottom(nodes2, subject.y1 + py, i + 1, alpha);
      resolveCollisionsBottomToTop(nodes2, y1, nodes2.length - 1, alpha);
      resolveCollisionsTopToBottom(nodes2, y0, 0, alpha);
    }
    function resolveCollisionsTopToBottom(nodes2, y2, i, alpha) {
      for (; i < nodes2.length; ++i) {
        const node = nodes2[i];
        const dy2 = (y2 - node.y0) * alpha;
        if (dy2 > 1e-6) node.y0 += dy2, node.y1 += dy2;
        y2 = node.y1 + py;
      }
    }
    function resolveCollisionsBottomToTop(nodes2, y2, i, alpha) {
      for (; i >= 0; --i) {
        const node = nodes2[i];
        const dy2 = (node.y1 - y2) * alpha;
        if (dy2 > 1e-6) node.y0 -= dy2, node.y1 -= dy2;
        y2 = node.y0 - py;
      }
    }
    function reorderNodeLinks({ sourceLinks, targetLinks }) {
      if (linkSort === void 0) {
        for (const { source: { sourceLinks: sourceLinks2 } } of targetLinks) {
          sourceLinks2.sort(ascendingTargetBreadth);
        }
        for (const { target: { targetLinks: targetLinks2 } } of sourceLinks) {
          targetLinks2.sort(ascendingSourceBreadth);
        }
      }
    }
    function reorderLinks(nodes2) {
      if (linkSort === void 0) {
        for (const { sourceLinks, targetLinks } of nodes2) {
          sourceLinks.sort(ascendingTargetBreadth);
          targetLinks.sort(ascendingSourceBreadth);
        }
      }
    }
    function targetTop(source, target) {
      let y2 = source.y0 - (source.sourceLinks.length - 1) * py / 2;
      for (const { target: node, width } of source.sourceLinks) {
        if (node === target) break;
        y2 += width + py;
      }
      for (const { source: node, width } of target.targetLinks) {
        if (node === source) break;
        y2 -= width;
      }
      return y2;
    }
    function sourceTop(source, target) {
      let y2 = target.y0 - (target.targetLinks.length - 1) * py / 2;
      for (const { source: node, width } of target.targetLinks) {
        if (node === source) break;
        y2 += width + py;
      }
      for (const { target: node, width } of source.sourceLinks) {
        if (node === target) break;
        y2 -= width;
      }
      return y2;
    }
    return sankey;
  }

  // node_modules/@tanstack/charts/dist/network-graph-internal.js
  function resolveNetworkGraph(nodeSource, linkSource, options, owner) {
    const nodes = toArray(nodeSource);
    const links = toArray(linkSource);
    const nodeKeys = transformValues(nodes, options.nodeKey);
    const sourceKeys = transformValues(links, options.source);
    const targetKeys = transformValues(links, options.target);
    const nodeIndexes = /* @__PURE__ */ new Map();
    nodeKeys.forEach((key, index) => {
      assertNetworkKey(key, `nodeKey at index ${index}`, owner);
      if (nodeIndexes.has(key)) {
        throw new TypeError(
          `${owner}: duplicate node key ${formatNetworkKey(key)}`
        );
      }
      nodeIndexes.set(key, index);
    });
    sourceKeys.forEach((key, index) => {
      assertNetworkEndpoint(key, index, "source", nodeIndexes, owner);
    });
    targetKeys.forEach((key, index) => {
      assertNetworkEndpoint(key, index, "target", nodeIndexes, owner);
    });
    return {
      nodes,
      links,
      nodeKeys,
      sourceKeys,
      targetKeys,
      nodeIndexes
    };
  }
  function assertNetworkEndpoint(key, index, endpoint, nodeIndexes, owner) {
    assertNetworkKey(key, `${endpoint} at link index ${index}`, owner);
    if (!nodeIndexes.has(key)) {
      throw new TypeError(
        `${owner}: ${endpoint} at link index ${index} does not match a node key: ${formatNetworkKey(key)}`
      );
    }
  }
  function assertNetworkKey(value2, name, owner) {
    if (typeof value2 !== "string" && !(typeof value2 === "number" && Number.isFinite(value2))) {
      throw new TypeError(`${owner}: ${name} must be a string or finite number`);
    }
  }
  function formatNetworkKey(key) {
    return `${typeof key}:${JSON.stringify(key)}`;
  }

  // node_modules/@tanstack/charts/dist/network-sankey.js
  function sankeyDiagram(options) {
    const graph = resolveNetworkGraph(
      options.nodes,
      options.links,
      {
        nodeKey: options.nodeKey,
        source: options.source,
        target: options.target
      },
      "sankeyDiagram"
    );
    const values = transformValues(graph.links, options.value);
    values.forEach(
      (value2, index) => assertNonnegativeFinite5(value2, `value at link index ${index}`)
    );
    if (graph.nodes.length > 0 && !values.some((value2) => value2 > 0)) {
      throw new TypeError(
        "sankeyDiagram: a nonempty graph requires at least one positive link value"
      );
    }
    const linkKeys = resolveLinkKeys(
      graph.links,
      graph.sourceKeys,
      graph.targetKeys,
      options.linkKey
    );
    const iterations = options.iterations ?? 6;
    assertNonnegativeInteger(iterations, "iterations");
    const align = options.align ?? "justify";
    const aligner = sankeyAligner(align);
    return createMarkWithScaleValues(
      ({ markIndex }) => {
        const id = options.id ?? `sankey-${markIndex}`;
        let childMotions = /* @__PURE__ */ new Map();
        const motion = (context) => resolveCompositeChildMotion(options.motion, childMotions, context);
        return {
          id,
          channels: {},
          motion,
          resolveLayout: ({ chart }) => {
            const nodeWidth = resolveLayoutNumber(
              options.nodeWidth,
              chart,
              24,
              "nodeWidth",
              true
            );
            const nodePadding = resolveLayoutNumber(
              options.nodePadding,
              chart,
              8,
              "nodePadding",
              false
            );
            const inset = resolveInset(options.inset, chart);
            const extent = {
              x0: chart.x + inset.left,
              y0: chart.y + inset.top,
              x1: chart.x + chart.width - inset.right,
              y1: chart.y + chart.height - inset.bottom
            };
            if (extent.x1 - extent.x0 < nodeWidth) {
              throw new TypeError(
                "sankeyDiagram: inset leaves less horizontal space than nodeWidth"
              );
            }
            if (extent.y1 <= extent.y0) {
              throw new TypeError(
                "sankeyDiagram: inset leaves no vertical layout space"
              );
            }
            const laidOut = graph.nodes.length === 0 ? { nodes: [], links: [] } : Sankey().nodeId((node) => node.key).nodeAlign(
              (node, columnCount) => aligner(
                node,
                columnCount
              )
            ).nodeWidth(nodeWidth).nodePadding(nodePadding).extent([
              [extent.x0, extent.y0],
              [extent.x1, extent.y1]
            ]).iterations(iterations).nodeSort(resolveNodeSort(options.nodeSort)).linkSort(resolveLinkSort(options.linkSort))({
              nodes: graph.nodes.map((data, index) => ({
                data,
                key: graph.nodeKeys[index],
                sourceIndex: index
              })),
              links: graph.links.map((data, index) => ({
                data,
                key: linkKeys[index],
                source: graph.sourceKeys[index],
                target: graph.targetKeys[index],
                value: values[index],
                sourceIndex: index
              }))
            });
            const output = materializeSankey(
              laidOut.nodes,
              laidOut.links,
              graph.nodeIndexes
            );
            const marks = options.marks({ id, chart, ...output });
            if (!Array.isArray(marks) || marks.length === 0) {
              throw new TypeError(
                "sankeyDiagram: marks must return at least one chart mark"
              );
            }
            const children = marks.map(
              (mark, childIndex) => mark.initialize({ markIndex: childIndex })
            );
            const composition = composeResolvedChildMarks(id, children);
            childMotions = new Map(
              children.flatMap((child, childIndex) => {
                const childMotion = child.motion ?? marks[childIndex]?.motion;
                if (childMotion === void 0) return [];
                return [[resolvedChildMarkId(id, child.id), childMotion]];
              })
            );
            return composition;
          }
        };
      },
      options.motion,
      options.renderer
    );
  }
  function materializeSankey(workingNodes, workingLinks, nodeIndexes) {
    const incoming = workingNodes.map(
      () => []
    );
    const outgoing = workingNodes.map(
      () => []
    );
    const nodes = workingNodes.map((node, index) => {
      const bounds = resolvedNodeBounds(node, index);
      const key = node.key;
      return {
        kind: "node",
        key,
        data: node.data,
        source: Object.freeze([node.data]),
        sourceIndexes: Object.freeze([node.sourceIndex]),
        index: resolvedInteger(node.index, `node index ${index}`),
        depth: resolvedInteger(node.depth, `node depth ${index}`),
        height: resolvedInteger(node.height, `node height ${index}`),
        layer: resolvedInteger(node.layer, `node layer ${index}`),
        value: resolvedFinite(node.value, `node value ${index}`),
        ...bounds,
        x: (bounds.x0 + bounds.x1) / 2,
        y: (bounds.y0 + bounds.y1) / 2,
        incomingLinks: incoming[index],
        outgoingLinks: outgoing[index]
      };
    });
    const links = workingLinks.map((link2, index) => {
      const sourceKey = resolvedWorkingNode(link2.source, index, "source").key;
      const targetKey = resolvedWorkingNode(link2.target, index, "target").key;
      const sourceIndex = nodeIndexes.get(sourceKey);
      const targetIndex = nodeIndexes.get(targetKey);
      const sourceNode = nodes[sourceIndex];
      const targetNode = nodes[targetIndex];
      return Object.freeze({
        kind: "link",
        key: link2.key,
        data: link2.data,
        sourceRows: Object.freeze([link2.data]),
        sourceIndexes: Object.freeze([link2.sourceIndex]),
        source: sourceKey,
        target: targetKey,
        sourceKey,
        targetKey,
        sourceIndex,
        targetIndex,
        sourceNode,
        targetNode,
        value: resolvedFinite(link2.value, `link value ${index}`),
        width: resolvedFinite(link2.width, `link width ${index}`),
        x1: sourceNode.x1,
        y1: resolvedFinite(link2.y0, `link source y ${index}`),
        x2: targetNode.x0,
        y2: resolvedFinite(link2.y1, `link target y ${index}`)
      });
    });
    workingNodes.forEach((node, index) => {
      for (const link2 of node.targetLinks ?? []) {
        incoming[index].push(links[link2.sourceIndex]);
      }
      for (const link2 of node.sourceLinks ?? []) {
        outgoing[index].push(links[link2.sourceIndex]);
      }
      Object.freeze(incoming[index]);
      Object.freeze(outgoing[index]);
      Object.freeze(nodes[index]);
    });
    return { nodes: Object.freeze(nodes), links: Object.freeze(links) };
  }
  function resolveLinkKeys(links, sourceKeys, targetKeys, linkKey) {
    if (linkKey !== void 0) {
      const keys = transformValues(links, linkKey);
      assertUniqueLinkKeys(keys);
      return keys;
    }
    const inferred = links.map(
      (link2) => link2 != null && typeof link2 === "object" ? link2.id : void 0
    );
    if (inferred.every(isChartKey3) && new Set(inferred).size === inferred.length) {
      return inferred;
    }
    const occurrences = /* @__PURE__ */ new Map();
    return links.map((_link, index) => {
      const pair3 = JSON.stringify([
        valueKey(sourceKeys[index]),
        valueKey(targetKeys[index])
      ]);
      const occurrence = occurrences.get(pair3) ?? 0;
      occurrences.set(pair3, occurrence + 1);
      return `link:${pair3}:${occurrence}`;
    });
  }
  function assertUniqueLinkKeys(keys) {
    const seen = /* @__PURE__ */ new Set();
    keys.forEach((key, index) => {
      if (!isChartKey3(key)) {
        throw new TypeError(
          `sankeyDiagram: linkKey at index ${index} must be a string or finite number`
        );
      }
      if (seen.has(key)) {
        throw new TypeError(
          `sankeyDiagram: duplicate link key ${typeof key}:${JSON.stringify(key)}`
        );
      }
      seen.add(key);
    });
  }
  function resolveNodeSort(sort) {
    if (sort === void 0 || sort === null) return sort;
    return (left2, right2) => {
      const compared = sort(
        nodeContext(left2),
        nodeContext(right2)
      );
      assertFinite3(compared, "nodeSort result");
      return compared;
    };
  }
  function resolveLinkSort(sort) {
    if (sort === void 0 || sort === null) return sort;
    return (left2, right2) => {
      const compared = sort(
        linkContext(left2),
        linkContext(right2)
      );
      assertFinite3(compared, "linkSort result");
      return compared;
    };
  }
  function nodeContext(node) {
    return {
      ...endpointContext(node),
      depth: resolvedInteger(node.depth, "nodeSort node depth"),
      height: resolvedInteger(node.height, "nodeSort node height"),
      value: resolvedFinite(node.value, "nodeSort node value")
    };
  }
  function endpointContext(node) {
    return {
      kind: "node",
      key: node.key,
      data: node.data,
      source: [node.data],
      sourceIndexes: [node.sourceIndex],
      index: resolvedInteger(node.index, "node index")
    };
  }
  function linkContext(link2) {
    const source = resolvedWorkingNode(link2.source, link2.sourceIndex, "source");
    const target = resolvedWorkingNode(link2.target, link2.sourceIndex, "target");
    return {
      kind: "link",
      key: link2.key,
      data: link2.data,
      sourceRows: [link2.data],
      sourceIndexes: [link2.sourceIndex],
      source: source.key,
      target: target.key,
      sourceKey: source.key,
      targetKey: target.key,
      sourceIndex: source.sourceIndex,
      targetIndex: target.sourceIndex,
      sourceNode: endpointContext(source),
      targetNode: endpointContext(target),
      value: link2.value
    };
  }
  function resolvedWorkingNode(endpoint, index, name) {
    if (typeof endpoint === "object") return endpoint;
    throw new TypeError(
      `sankeyDiagram: unresolved ${name} at link index ${index}`
    );
  }
  function resolvedNodeBounds(node, index) {
    return {
      x0: resolvedFinite(node.x0, `node x0 ${index}`),
      x1: resolvedFinite(node.x1, `node x1 ${index}`),
      y0: resolvedFinite(node.y0, `node y0 ${index}`),
      y1: resolvedFinite(node.y1, `node y1 ${index}`)
    };
  }
  function sankeyAligner(align) {
    const selected = typeof align === "function" ? align : align === "left" ? left : align === "right" ? right : align === "center" ? center : align === "justify" ? justify : void 0;
    if (!selected) {
      throw new TypeError(`sankeyDiagram: invalid alignment "${String(align)}"`);
    }
    return (node, columnCount) => {
      const layer = selected(node, columnCount);
      if (!Number.isInteger(layer) || layer < 0 || layer >= columnCount) {
        throw new TypeError(
          `sankeyDiagram: align result must be an integer between 0 and ${columnCount - 1}`
        );
      }
      return layer;
    };
  }
  function resolveLayoutNumber(value2, chart, fallback, name, positive) {
    const resolved = typeof value2 === "function" ? value2(chart) : value2;
    const number5 = resolved ?? fallback;
    if (!Number.isFinite(number5) || (positive ? number5 <= 0 : number5 < 0)) {
      throw new TypeError(
        `sankeyDiagram: ${name} must be a ${positive ? "positive" : "nonnegative"} finite number`
      );
    }
    return number5;
  }
  function resolveInset(value2, chart) {
    const resolved = typeof value2 === "function" ? value2(chart) : value2;
    const inset = typeof resolved === "number" ? { top: resolved, right: resolved, bottom: resolved, left: resolved } : {
      top: resolved?.top ?? 0,
      right: resolved?.right ?? 0,
      bottom: resolved?.bottom ?? 0,
      left: resolved?.left ?? 0
    };
    for (const [name, amount] of Object.entries(inset)) {
      assertNonnegativeFinite5(amount, `inset.${name}`);
    }
    return inset;
  }
  function resolvedFinite(value2, name) {
    assertFinite3(value2, name);
    return value2;
  }
  function resolvedInteger(value2, name) {
    if (!Number.isInteger(value2) || value2 < 0) {
      throw new TypeError(`sankeyDiagram: layout produced an invalid ${name}`);
    }
    return value2;
  }
  function assertFinite3(value2, name) {
    if (typeof value2 !== "number" || !Number.isFinite(value2)) {
      throw new TypeError(`sankeyDiagram: layout produced a non-finite ${name}`);
    }
  }
  function assertNonnegativeFinite5(value2, name) {
    if (typeof value2 !== "number" || !Number.isFinite(value2) || value2 < 0) {
      throw new TypeError(
        `sankeyDiagram: ${name} must be a nonnegative finite number`
      );
    }
  }
  function assertNonnegativeInteger(value2, name) {
    if (!Number.isInteger(value2) || value2 < 0) {
      throw new TypeError(`sankeyDiagram: ${name} must be a nonnegative integer`);
    }
  }
  function isChartKey3(value2) {
    return typeof value2 === "string" || typeof value2 === "number" && Number.isFinite(value2);
  }

  // entry.mjs
  var VAR = {
    muted: "var(--td-muted)",
    good: "var(--td-good)",
    warning: "var(--td-warning)",
    critical: "var(--td-critical)",
    surface: "var(--td-surface)",
    ink: "var(--td-ink)",
    ink2: "var(--td-ink2)",
    grid: "var(--td-grid)",
    base: "var(--td-base)"
  };
  var SERIES = Array.from({ length: 8 }, (_, i) => `var(--td-s${i + 1})`);
  var SEQ = Array.from({ length: 5 }, (_, i) => `var(--td-q${i + 1})`);
  function color(token) {
    if (typeof token !== "string" || token.charAt(0) !== "@") return token;
    const key = token.slice(1);
    let m = /^series(\d+)$/.exec(key);
    if (m) return SERIES[(parseInt(m[1], 10) - 1) % SERIES.length];
    m = /^seq(\d+)$/.exec(key);
    if (m) return SEQ[Math.min(parseInt(m[1], 10) - 1, SEQ.length - 1)];
    return key in VAR ? VAR[key] : token;
  }
  var THEME = {
    foreground: VAR.ink2,
    muted: VAR.muted,
    grid: VAR.grid,
    background: "transparent",
    palette: SERIES
  };
  function formatter(spec, locale2) {
    const f = spec || {};
    const loc = f.locale || locale2 || "de-DE";
    const opts = { maximumFractionDigits: f.decimals == null ? 2 : f.decimals };
    if (f.decimals != null) opts.minimumFractionDigits = f.decimals;
    if (f.compact) {
      opts.notation = "compact";
      opts.maximumFractionDigits = f.decimals == null ? 1 : f.decimals;
      delete opts.minimumFractionDigits;
    }
    const nf = new Intl.NumberFormat(loc, opts);
    const unit = f.percent ? "%" : f.unit || "";
    return (value2) => {
      if (value2 == null || !Number.isFinite(Number(value2))) return "";
      const text2 = nf.format(Number(value2));
      return unit ? `${text2}\xA0${unit}` : text2;
    };
  }
  function axisFrom(spec, locale2, fallbackFormat) {
    const s = spec || {};
    const axis = { line: false };
    const fmt = s.format || fallbackFormat;
    axis.ticks = fmt ? { format: formatter(fmt, locale2) } : {};
    if (s.ticks) axis.ticks.count = s.ticks;
    if (s.label) axis.label = s.label;
    if (s.rotate) axis.tickLabels = { rotate: s.rotate };
    else axis.tickLabels = { thin: { minGap: s.min_gap || 8, priority: "ends" } };
    return axis;
  }
  function linearScale(spec, values) {
    const s = spec || {};
    if (s.min == null && s.max == null) return { scale: scaleLinear, nice: true };
    const finite2 = (values || []).filter((v) => v != null && Number.isFinite(v));
    const lo = s.min != null ? s.min : Math.min(...finite2, 0);
    const hi = s.max != null ? s.max : Math.max(...finite2, lo + 1);
    return { scale: scaleLinear().domain([lo, hi]).nice() };
  }
  var longRows = (categories, series) => {
    const rows = [];
    categories.forEach((c, i) => {
      series.forEach((s) => {
        rows.push({ c, s: s.name, v: s.data[i] == null ? null : s.data[i], i });
      });
    });
    return rows;
  };
  var wideRows = (categories, values) => categories.map((c, i) => ({ c, v: values[i] == null ? null : values[i], i }));
  var bandScale = (domain, padding) => scaleBand().domain(domain).padding(padding == null ? 0.2 : padding);
  var legendFor = (spec, count2, label) => count2 > 1 && spec.legend !== false ? colorLegend({ label: label || "" }) : void 0;
  var seriesList = (spec) => (spec.series || []).map((s) => ({ name: String(s.name), data: s.data || [] }));
  function numbersOf(spec) {
    if (spec.values) return spec.values;
    if (spec.series) return spec.series.flatMap((s) => s.data || []);
    if (spec.bars) return spec.bars.flatMap((b) => [b.y1, b.y2]);
    if (spec.cells) return spec.cells.map((c) => c[2]);
    if (spec.bins) return spec.bins.map((b) => b[2]);
    if (spec.points) return spec.points.map((p) => p[1]);
    if (spec.groups) return spec.groups.flat();
    return [];
  }
  var BUILD = {};
  BUILD.line = (spec, ctx) => {
    const cats = spec.categories.map(String);
    const series = seriesList(spec);
    const rows = longRows(cats, series);
    const marks = [];
    if (spec.area_first && series.length) {
      const first = rows.filter((r) => r.s === series[0].name);
      marks.push(
        areaY(first, {
          x: "c",
          y: "v",
          fill: color("@series1"),
          fillOpacity: 0.14,
          curve: d3Curve(monotoneX)
        })
      );
    }
    marks.push(
      lineY(rows, {
        x: "c",
        y: "v",
        z: "s",
        color: "s",
        strokeWidth: 2,
        curve: spec.smooth === false ? void 0 : d3Curve(monotoneX)
      })
    );
    return definition(spec, ctx, {
      marks,
      scales: {
        x: { scale: scalePoint().domain(cats).padding(0.06), axis: axisFrom(spec.x, ctx.locale) },
        y: { ...linearScale(spec.y, ctx.numbers), grid: true, axis: axisFrom(spec.y, ctx.locale, ctx.numberFormat) }
      },
      color: { domain: series.map((s) => s.name), range: SERIES, legend: legendFor(spec, series.length) },
      focus: "group-x"
    });
  };
  BUILD.area = (spec, ctx) => {
    const cats = spec.categories.map(String);
    const rows = wideRows(cats, spec.values);
    return definition(spec, ctx, {
      marks: [
        areaY(rows, {
          x: "c",
          y: "v",
          fill: color("@series1"),
          fillOpacity: 0.18,
          curve: d3Curve(monotoneX)
        }),
        lineY(rows, { x: "c", y: "v", stroke: color("@series1"), strokeWidth: 2, curve: d3Curve(monotoneX) })
      ],
      scales: {
        x: { scale: scalePoint().domain(cats).padding(0.02), axis: axisFrom(spec.x, ctx.locale) },
        y: { ...linearScale(spec.y, ctx.numbers), grid: true, axis: axisFrom(spec.y, ctx.locale, ctx.numberFormat) }
      },
      focus: "group-x"
    });
  };
  BUILD.bar = (spec, ctx) => {
    const cats = spec.categories.map(String);
    const rows = wideRows(cats, spec.values);
    const hi = spec.highlight;
    const paint = (row) => hi == null || row.c === hi || row.i === hi ? color("@series1") : color("@muted");
    const marks = [barY(rows, { x: "c", y: "v", fill: paint, radius: 4, maxThickness: 44 })];
    if (spec.label !== false) {
      marks.push(
        text(rows, {
          x: "c",
          y: "v",
          text: (row) => ctx.value(row.v),
          anchor: "middle",
          dy: -8,
          fontSize: 11,
          fill: VAR.ink2
        })
      );
    }
    return definition(spec, ctx, {
      marks,
      scales: {
        x: { scale: bandScale(cats, 0.24), axis: axisFrom(spec.x, ctx.locale) },
        y: { ...linearScale(spec.y, ctx.numbers), grid: true, axis: axisFrom(spec.y, ctx.locale, ctx.numberFormat) }
      }
    });
  };
  BUILD.hbar = (spec, ctx) => {
    const cats = spec.categories.map(String);
    const rows = wideRows(cats, spec.values);
    return definition(spec, ctx, {
      marks: [
        barX(rows, { x: "v", y: "c", fill: color("@series1"), radius: 3, maxThickness: 22 }),
        text(rows, {
          x: "v",
          y: "c",
          text: (row) => ctx.value(row.v),
          anchor: "start",
          dx: 6,
          fontSize: 11,
          fill: VAR.ink2
        })
      ],
      scales: {
        y: { scale: bandScale(cats, 0.3), axis: axisFrom(spec.y, ctx.locale) },
        x: { ...linearScale(spec.x, ctx.numbers), grid: true, axis: axisFrom(spec.x, ctx.locale, ctx.numberFormat) }
      }
    });
  };
  BUILD.grouped_bar = (spec, ctx) => {
    const cats = spec.categories.map(String);
    const series = seriesList(spec);
    const rows = longRows(cats, series);
    return definition(spec, ctx, {
      marks: [
        barY(rows, { x: "c", y: "v", z: "s", color: "s", layout: group({ padding: 0.08 }), radius: 3 })
      ],
      scales: {
        x: { scale: bandScale(cats, 0.2), axis: axisFrom(spec.x, ctx.locale) },
        y: { ...linearScale(spec.y, ctx.numbers), grid: true, axis: axisFrom(spec.y, ctx.locale, ctx.numberFormat) }
      },
      color: { domain: series.map((s) => s.name), range: SERIES, legend: legendFor(spec, series.length) }
    });
  };
  BUILD.stacked_bar = (spec, ctx) => {
    const cats = spec.categories.map(String);
    const series = seriesList(spec);
    const rows = longRows(cats, series);
    const order = series.map((s) => s.name);
    return definition(spec, ctx, {
      marks: [
        barY(rows, {
          x: "c",
          y: "v",
          z: "s",
          color: "s",
          layout: stack({ order }),
          // A 2px ring in the surface colour separates adjacent segments, so the
          // boundary is structural rather than a hue change the eye has to find.
          stroke: VAR.surface,
          strokeWidth: 2
        })
      ],
      scales: {
        x: { scale: bandScale(cats, 0.24), axis: axisFrom(spec.x, ctx.locale) },
        y: { ...linearScale(spec.y, ctx.numbers), grid: true, axis: axisFrom(spec.y, ctx.locale, ctx.numberFormat) }
      },
      color: { domain: order, range: SERIES, legend: legendFor(spec, series.length) }
    });
  };
  BUILD.waterfall = (spec, ctx) => {
    const rows = spec.bars.map((b, i) => ({ ...b, i }));
    const cats = rows.map((r) => String(r.label));
    const paint = (row) => row.role === "total" ? color("@series1") : row.role === "rise" ? color("@good") : color("@critical");
    return definition(spec, ctx, {
      marks: [
        barY(rows, { x: "label", y1: "y1", y2: "y2", fill: paint, radius: 2, maxThickness: 46 }),
        ruleY([0], { stroke: VAR.base }),
        text(rows, {
          x: "label",
          y: (row) => Math.max(row.y1, row.y2),
          text: (row) => ctx.value(row.delta),
          anchor: "middle",
          dy: -8,
          fontSize: 11,
          fill: VAR.ink2
        })
      ],
      scales: {
        x: { scale: bandScale(cats, 0.22), axis: axisFrom(spec.x, ctx.locale) },
        y: { ...linearScale(spec.y, ctx.numbers), grid: true, axis: axisFrom(spec.y, ctx.locale, ctx.numberFormat) }
      }
    });
  };
  BUILD.scatter = (spec, ctx) => {
    const rows = spec.points.map((p, i) => ({
      x: p[0],
      y: p[1],
      r: spec.sizes ? spec.sizes[i] : void 0,
      label: spec.labels ? spec.labels[i] : void 0,
      i
    }));
    return definition(spec, ctx, {
      marks: [
        dot(rows, {
          x: "x",
          y: "y",
          r: spec.sizes ? "r" : 6,
          fill: color("@series1"),
          fillOpacity: 0.85,
          // A surface-coloured ring keeps overlapping dots countable.
          stroke: VAR.surface,
          strokeWidth: 2
        })
      ],
      scales: {
        x: { scale: scaleLinear, nice: true, grid: true, axis: axisFrom(spec.x, ctx.locale) },
        y: { ...linearScale(spec.y, ctx.numbers), grid: true, axis: axisFrom(spec.y, ctx.locale, ctx.numberFormat) }
      }
    });
  };
  BUILD.heatmap = (spec, ctx) => {
    const rows = spec.cells.map((c) => ({
      x: String(spec.x_labels[c[0]]),
      y: String(spec.y_labels[c[1]]),
      v: c[2]
    }));
    const values = rows.map((r) => r.v).filter((v) => v != null);
    const low = spec.low != null ? spec.low : Math.min(...values, 0);
    const high = spec.high != null ? spec.high : Math.max(...values, 1);
    const marks = [cell(rows, { x: "x", y: "y", color: "v", inset: 1, radius: 2 })];
    if (rows.length <= 60) {
      marks.push(
        text(rows, {
          x: "x",
          y: "y",
          text: (row) => ctx.value(row.v),
          fontSize: 10,
          fill: VAR.ink2
        })
      );
    }
    return definition(spec, ctx, {
      marks,
      scales: {
        x: { scale: bandScale(spec.x_labels.map(String), 0.02), axis: axisFrom(spec.x, ctx.locale) },
        y: { scale: bandScale(spec.y_labels.map(String), 0.02), axis: axisFrom(spec.y, ctx.locale) }
      },
      color: {
        // Magnitude is one hue, light to dark. A rainbow ramp invents category
        // boundaries the data does not have.
        scale: quantize().domain([low, high]).range(SEQ),
        legend: spec.legend === false ? void 0 : colorGradientLegend({ label: spec.unit || "" })
      }
    });
  };
  var pieDefinition = (spec, ctx, inner) => {
    const rows = spec.labels.map((label, i) => ({ label: String(label), v: spec.values[i] }));
    const slices = pie(rows, { value: "v", gapAngle: 0.012 });
    const total = rows.reduce((sum3, r) => sum3 + (r.v || 0), 0) || 1;
    return definition(spec, ctx, {
      marks: [
        polar({
          inset: 8,
          radiusRatio: 0.86,
          // `radialArc` carries its own authored geometry, but the slice labels
          // are positioned through the angle and radius channels, and a channel
          // without a scale has nothing to map through. Radians in, radians out;
          // radius is expressed as a fraction of the resolved outer radius.
          scales: {
            angle: { scale: scaleLinear().domain([0, Math.PI * 2]) },
            radius: { scale: scaleLinear().domain([0, 1]) }
          },
          marks: [
            radialArc(slices, {
              innerRadius: inner ? ({ radius }) => radius * 0.58 : 0,
              cornerRadius: 3,
              color: "label",
              key: "label",
              stroke: VAR.surface,
              strokeWidth: 2
            }),
            radialText(slices, {
              angle: (row) => row.angle,
              radius: () => inner ? 0.79 : 0.7,
              // The share only. A scene text node is one line — a name and a
              // percentage in the same label run off the slice on one side and
              // out of the card on the other — and the legend already names the
              // slices.
              text: (row) => row.value / total >= 0.04 ? `${Math.round(row.value / total * 100)} %` : "",
              key: "label",
              fill: VAR.ink,
              fontSize: 12,
              fontWeight: 600
            })
          ]
        })
      ],
      scales: { x: null, y: null },
      color: { domain: rows.map((r) => r.label), range: SERIES, legend: legendFor(spec, rows.length) }
    });
  };
  BUILD.pie = (spec, ctx) => pieDefinition(spec, ctx, false);
  BUILD.donut = (spec, ctx) => pieDefinition(spec, ctx, true);
  BUILD.radar = (spec, ctx) => {
    const axes = spec.indicators.map(String);
    const series = seriesList(spec);
    const rows = [];
    series.forEach((s) => {
      axes.forEach((axis, i) => {
        const max3 = spec.maxes[i] || 1;
        rows.push({ axis, s: s.name, r: s.data[i] == null ? null : s.data[i] / max3, raw: s.data[i] });
      });
    });
    return definition(spec, ctx, {
      marks: [
        polar({
          radiusRatio: 0.74,
          scales: {
            angle: { scale: scalePoint().domain(axes), wrap: true },
            radius: { scale: scaleLinear().domain([0, 1]) }
          },
          guides: [
            radialGrid({ values: [0.25, 0.5, 0.75, 1], shape: "polygon" }),
            angleGrid({ labels: true })
          ],
          marks: series.flatMap((s, i) => {
            const own = rows.filter((r) => r.s === s.name);
            return [
              radialArea(own, {
                angle: "axis",
                radius: "r",
                curve: linearClosed_default,
                fill: SERIES[i % SERIES.length],
                fillOpacity: 0.15
              }),
              radialLine(own, {
                angle: "axis",
                radius: "r",
                curve: linearClosed_default,
                stroke: SERIES[i % SERIES.length],
                strokeWidth: 2
              })
            ];
          })
        })
      ],
      scales: { x: null, y: null },
      color: { domain: series.map((s) => s.name), range: SERIES, legend: legendFor(spec, series.length) }
    });
  };
  BUILD.gauge = (spec, ctx) => {
    const value2 = Math.max(0, Math.min(spec.target, spec.value));
    const parts = [
      { id: "value", v: value2 },
      { id: "rest", v: Math.max(spec.target - value2, 0) }
    ];
    const slices = pie(parts, {
      value: "v",
      startAngle: -Math.PI * 0.75,
      endAngle: Math.PI * 0.75
    });
    return definition(spec, ctx, {
      marks: [
        polar({
          radiusRatio: 0.86,
          scales: {
            angle: { scale: scaleLinear().domain([0, 1]) },
            radius: { scale: scaleLinear().domain([0, 1]) }
          },
          marks: [
            radialArc(slices, {
              innerRadius: ({ radius }) => radius * 0.7,
              cornerRadius: 999,
              color: "id",
              key: "id"
            }),
            radialText([{ id: "reading" }], {
              angle: 0,
              radius: 0,
              text: () => `${ctx.value(spec.value)}${spec.unit || ""}`,
              key: "id",
              fill: VAR.ink,
              fontSize: 26,
              fontWeight: 650
            }),
            radialText([{ id: "name" }], {
              angle: 0,
              radius: 0.42,
              text: () => spec.name || "",
              key: "id",
              fill: VAR.muted,
              fontSize: 12
            })
          ]
        })
      ],
      scales: { x: null, y: null },
      color: { domain: ["value", "rest"], range: [color("@series1"), VAR.grid] }
    });
  };
  BUILD.funnel = (spec, ctx) => {
    const rows = spec.stages.map((label, i) => {
      const v = spec.values[i] || 0;
      const first = spec.values[0] || 1;
      return { label: String(label), v, half: v / 2, share: v / first };
    });
    const cats = rows.map((r) => r.label);
    const span = Math.max(...rows.map((r) => r.half), 1);
    return definition(spec, ctx, {
      marks: [
        rect(rows, {
          y: "label",
          x1: (row) => -row.half,
          x2: "half",
          fill: color("@series1"),
          radius: 3,
          inset: 3
        }),
        // Outside the bar, never inside it: the last stage of a funnel is the
        // narrowest bar on the chart and the one whose number matters most, and
        // an inside label is exactly the one that gets clipped there.
        text(rows, {
          y: "label",
          x: "half",
          text: (row) => `${ctx.value(row.v)} (${Math.round(row.share * 100)} %)`,
          anchor: "start",
          dx: 8,
          fill: VAR.ink2,
          fontSize: 11
        })
      ],
      scales: {
        y: { scale: bandScale(cats, 0.14), axis: { line: false, ticks: { size: 0 } } },
        x: { scale: scaleLinear().domain([-span, span]), axis: false }
      }
    });
  };
  BUILD.boxplot = (spec, ctx) => {
    const rows = [];
    spec.groups.forEach((values, i) => {
      values.forEach((v, j) => rows.push({ c: String(spec.categories[i]), v, k: `${i}-${j}` }));
    });
    return definition(spec, ctx, {
      marks: [
        boxY(rows, {
          x: "c",
          y: "v",
          key: "k",
          // The interquartile box is a filled shape, not an outline: filling it
          // with the card colour leaves whiskers and a median floating in space.
          fill: color("@seq1"),
          stroke: color("@series1")
        })
      ],
      scales: {
        x: { scale: bandScale(spec.categories.map(String), 0.3), axis: axisFrom(spec.x, ctx.locale) },
        y: { ...linearScale(spec.y, ctx.numbers), grid: true, axis: axisFrom(spec.y, ctx.locale, ctx.numberFormat) }
      }
    });
  };
  BUILD.histogram = (spec, ctx) => {
    const rows = spec.bins.map((b, i) => ({ x1: b[0], x2: b[1], count: b[2], i }));
    return definition(spec, ctx, {
      marks: [rect(rows, { x1: "x1", x2: "x2", y1: () => 0, y2: "count", inset: 1, fill: color("@series1"), radius: 2 })],
      scales: {
        x: { scale: scaleLinear, nice: true, axis: axisFrom(spec.x, ctx.locale) },
        y: { ...linearScale(spec.y, ctx.numbers), grid: true, axis: axisFrom(spec.y, ctx.locale, ctx.numberFormat) }
      }
    });
  };
  BUILD.treemap = (spec, ctx) => definition(spec, ctx, {
    marks: [
      treemap(spec.nodes, {
        path: "path",
        delimiter: "/",
        value: "value",
        color: (node) => node.ancestorIds.at(-1) ?? node.id,
        label: "name",
        inset: 1,
        stroke: VAR.surface,
        strokeWidth: 2,
        radius: 3
      })
    ],
    scales: { x: null, y: null },
    color: { range: SERIES },
    guides: false,
    margin: 0
  });
  BUILD.sankey = (spec, ctx) => definition(spec, ctx, {
    marks: [
      sankeyDiagram({
        nodes: spec.nodes,
        links: spec.links,
        nodeKey: "id",
        source: "source",
        target: "target",
        value: "value",
        align: "left",
        nodePadding: 22,
        inset: { left: 8, right: 8, top: 20, bottom: 10 },
        marks: ({ nodes, links }) => [
          link(links, {
            x1: "x1",
            y1: "y1",
            x2: "x2",
            y2: "y2",
            key: "key",
            strokeWidth: (flow) => flow.width,
            strokeOpacity: 0.4,
            stroke: color("@series1"),
            // Default round caps on a band a hundred pixels wide bulge past
            // both node columns and read as a shape rather than a flow.
            lineCap: "butt"
          }),
          rect(nodes, { x1: "x0", x2: "x1", y1: "y0", y2: "y1", key: "key", inset: 0, fill: color("@series1") }),
          text(nodes, {
            x: "x",
            y: (node) => node.y0 - 7,
            text: (node) => node.data.label,
            key: "key",
            fill: VAR.ink2,
            fontSize: 11,
            fontWeight: 600
          })
        ]
      })
    ],
    scales: { x: null, y: null },
    guides: false,
    margin: 0
  });
  function definition(spec, ctx, base) {
    return defineChart({
      ...base,
      theme: THEME,
      tooltip: {
        use: tooltip,
        format: (point3) => ctx.tip(point3)
      }
    });
  }
  function mount(el, spec, options) {
    const opts = options || {};
    const locale2 = opts.locale || "de-DE";
    const numberFormat = spec.value_format || spec.y && spec.y.format || spec.x && spec.x.format;
    const value2 = formatter(numberFormat, locale2);
    const ctx = {
      locale: locale2,
      value: value2,
      numberFormat,
      numbers: numbersOf(spec),
      tip: (point3) => {
        const d = point3.datum || {};
        const label = d.label ?? d.c ?? d.axis ?? d.x ?? point3.xValue;
        const number5 = d.v ?? d.value ?? d.count ?? point3.yValue;
        const series = d.s ? `${d.s} \xB7 ` : "";
        return `${series}${label ?? ""}: ${value2(number5)}`;
      }
    };
    const build = BUILD[spec.type];
    if (!build) throw new Error(`unknown chart type ${JSON.stringify(spec.type)}`);
    return mountChart(el, {
      definition: build(spec, ctx),
      height: opts.height || 340,
      initialWidth: opts.initialWidth || 640,
      ariaLabel: opts.ariaLabel || spec.type
    });
  }
  function mountAll(specs, options) {
    const hosts = {};
    specs.forEach((entry) => {
      const el = document.getElementById(entry.id);
      if (!el) return;
      try {
        hosts[entry.id] = mount(el, entry.spec, {
          ...options,
          height: entry.height,
          ariaLabel: entry.title
        });
      } catch (error) {
        console.error(entry.id, error);
        el.innerHTML = "";
        const p = document.createElement("p");
        p.className = "chart-error";
        p.textContent = `Chart ${entry.id} failed: ${error && error.message ? error.message : error}`;
        el.appendChild(p);
      }
    });
    return hosts;
  }
  var types = Object.keys(BUILD).sort();
  return __toCommonJS(entry_exports);
})();
