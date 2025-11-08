class ThreadingSingle {
  static ECompositingOperation = Object.freeze({
    DARKEN: 0,
    LIGHTEN: 1,
  });

  static EColor = Object.freeze({
    MONOCHROME: 0,
    RED: 1,
    GREEN: 2,
    BLUE: 3,
  });

  static #advancedCompositingSupported = true;

  static DEFAULT_OPTIONS = {
    shape: "circle",
    pegsCount: 250,
    quality: 1,
    mode: "monochrome",
    invertColors: false,
    nbLines: 1000,
    lineOpacity: 1 / 16,
    lineThickness: 1,
    zoom: 1,
    zoomOffsetX: 0,
    zoomOffsetY: 0,
  };

  constructor(sourceImage, options = {}) {
    if (!(sourceImage instanceof HTMLImageElement)) {
      throw new TypeError("ThreadingSingle expects an HTMLImageElement as source.");
    }

    this.sourceImage = sourceImage;

    // Force the simple compositing path so strokes render as solid threads.
    this.parameters = { ...ThreadingSingle.DEFAULT_OPTIONS, ...options };

    this.hiddenCanvas = document.createElement("canvas");
    this.hiddenCanvasContext = this.hiddenCanvas.getContext("2d");
    this.hiddenCanvasData = null;

    this.thread = null;
    this.pegs = [];
    this.error = { average: 0, meanSquare: 0, variance: 0 };
    this.lineOpacityInternal = 0;

    this.reset(this.parameters.lineOpacity, this.parameters.lineThickness);
  }

  configure(overrides = {}) {
    Object.assign(this.parameters, overrides);
    this.reset(
      overrides.lineOpacity ?? this.parameters.lineOpacity,
      overrides.lineThickness ?? this.parameters.lineThickness
    );
  }

  reset(lineOpacity = this.parameters.lineOpacity, lineThickness = this.parameters.lineThickness) {
    this.parameters.lineOpacity = lineOpacity;
    this.parameters.lineThickness = lineThickness;
    this.hiddenCanvasScale = this.parameters.quality;

    if (this.parameters.mode === "monochrome") {
      this.thread = new ThreadingSingle.ThreadMonochrome();
    } else {
      this.thread = new ThreadingSingle.ThreadRedBlueGreen();
    }

    this.resetHiddenCanvas();
    this.pegs = this.computePegs();
  }

  get nbSegments() {
    return this.thread.totalNbSegments;
  }

  drawThread(plotter, fromSegment = 0) {
    const transformation = this.computeTransformation(plotter.size);
    const thickness = transformation.scaling * this.hiddenCanvasScale * this.parameters.lineThickness;
    const operation = this.parameters.invertColors
      ? ThreadingSingle.ECompositingOperation.LIGHTEN
      : ThreadingSingle.ECompositingOperation.DARKEN;

    this.thread.iterateOnThreads(fromSegment, (threadPoints, color) => {
      const transformed = threadPoints.map((peg) => transformation.transform(peg));
      plotter.drawBrokenLine(transformed, color, this.parameters.lineOpacity, operation, thickness);
    });
  }

  drawPegs(plotter) {
    const transformation = this.computeTransformation(plotter.size);
    const radius = transformation.scaling * this.hiddenCanvasScale * 0.5;
    const points = this.pegs.map((peg) => transformation.transform(peg));
    plotter.drawPoints(points, "red", radius);
  }

  drawDebugView(context) {
    context.drawImage(this.hiddenCanvas, 0, 0, this.hiddenCanvas.width, this.hiddenCanvas.height);
  }

  updateIndicators(setter) {
    setter("pegs-count", String(this.pegs.length));
    setter("segments-count", String(this.nbSegments));
    setter("error-average", String(this.error.average));
    setter("error-mean-square", String(this.error.meanSquare));
    setter("error-variance", String(this.error.variance));
  }

  computeNextSegments(maxDurationMs) {
    const maxSegments = this.parameters.nbLines;

    if (this.nbSegments === maxSegments) {
      return false;
    }

    if (this.nbSegments > maxSegments) {
      this.thread.lowerNbSegments(maxSegments);
      this.resetHiddenCanvas();

      this.thread.iterateOnThreads(0, (threadPoints, color) => {
        ThreadingSingle.applyCanvasCompositing(
          this.hiddenCanvasContext,
          color,
          this.lineOpacityInternal,
          ThreadingSingle.ECompositingOperation.LIGHTEN
        );

        for (let i = 0; i < threadPoints.length - 1; i++) {
          this.drawSegmentOnHiddenCanvas(threadPoints[i], threadPoints[i + 1]);
        }
      });

      this.computeError();
      return true;
    }

    const now = ThreadingSingle.now();
    const startTime = now();
    let currentColor = null;

    while (this.nbSegments < maxSegments && now() - startTime < maxDurationMs) {
      const selection = this.thread.getThreadToGrow();

      if (currentColor !== selection.color) {
        ThreadingSingle.applyCanvasCompositing(
          this.hiddenCanvasContext,
          selection.color,
          this.lineOpacityInternal,
          ThreadingSingle.ECompositingOperation.LIGHTEN
        );
        this.thread.enableSamplingFor(selection.color);
        currentColor = selection.color;
      }

      this.computeSegment(selection.thread);

      if (this.nbSegments % 100 === 0) {
        this.computeError();
      }
    }

    return true;
  }

  get instructions() {
    if (this.parameters.mode !== "monochrome") {
      return "Instructions are only available for monochrome mode.";
    }

    if (this.parameters.invertColors) {
      return "Instructions are only available for black thread.";
    }

    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const peg of this.pegs) {
      maxX = Math.max(maxX, peg.x);
      maxY = Math.max(maxY, peg.y);
    }

    const lines = [];
    ines.push("Space units below are abstract — scale them to your needs (e.g. 1 unit = 1 mm).");
    lines.push(`Computed for a total size of ${maxX} x ${maxY}.`);

    const threadWidth = this.parameters.lineThickness * this.hiddenCanvasScale;
    lines.push(
      `Computed for a black thread of width ${threadWidth} and opacity ${this.parameters.lineOpacity} (equivalent opaque width ${
        threadWidth * this.parameters.lineOpacity
      }).`
    );
    lines.push("");
    lines.push("Peg positions:");

    this.pegs.forEach((peg, index) => {
      peg.name = `PEG_${index}`;
      lines.push(`  - ${peg.name}: x=${peg.x.toFixed(2)} ; y=${peg.y.toFixed(2)}`);
    });

    lines.push("");
    lines.push("Thread steps:");

    this.thread.iterateOnThreads(0, (threadPoints) => {
      const sequence = threadPoints;
      lines.push(`  - Start from ${sequence[0].name}`);

      for (let i = 1; i < sequence.length; i++) {
        lines.push(`  - then go to ${sequence[i].name} (segment ${i} / ${sequence.length - 1})`);
      }
    });

    return lines.join("\n");
  }

  computeTransformation(size) {
    return new ThreadingSingle.Transformation(size, this.hiddenCanvas);
  }

  initializeHiddenCanvasLineProperties() {
    const width = this.parameters.lineThickness * this.hiddenCanvasScale;

    if (width <= 1) {
      this.lineOpacityInternal = 0.5 * this.parameters.lineOpacity * width;
      this.hiddenCanvasContext.lineWidth = 1;
    } else {
      this.lineOpacityInternal = 0.5 * this.parameters.lineOpacity;
      this.hiddenCanvasContext.lineWidth = width;
    }
  }

  resetHiddenCanvas() {
    const size = ThreadingSingle.computeBestSize(this.sourceImage, 100 * this.hiddenCanvasScale);
    this.hiddenCanvas.width = size.width;
    this.hiddenCanvas.height = size.height;

    ThreadingSingle.resetCanvasCompositing(this.hiddenCanvasContext);

    const zoom = Math.max(1, Number(this.parameters.zoom) || 1);
    const offsetX = ThreadingSingle.clamp(Number(this.parameters.zoomOffsetX) || 0, -1, 1);
    const offsetY = ThreadingSingle.clamp(Number(this.parameters.zoomOffsetY) || 0, -1, 1);

    const cropWidth = Math.max(1, Math.round(this.sourceImage.width / zoom));
    const cropHeight = Math.max(1, Math.round(this.sourceImage.height / zoom));

    const centerOffsetX = 0.5 * (this.sourceImage.width - cropWidth);
    const centerOffsetY = 0.5 * (this.sourceImage.height - cropHeight);

    const maxOffsetX = centerOffsetX;
    const maxOffsetY = centerOffsetY;

    const sourceX = ThreadingSingle.clamp(
      Math.round(centerOffsetX + offsetX * maxOffsetX),
      0,
      this.sourceImage.width - cropWidth
    );
    const sourceY = ThreadingSingle.clamp(
      Math.round(centerOffsetY + offsetY * maxOffsetY),
      0,
      this.sourceImage.height - cropHeight
    );

    this.hiddenCanvasContext.drawImage(
      this.sourceImage,
      sourceX,
      sourceY,
      cropWidth,
      cropHeight,
      0,
      0,
      size.width,
      size.height
    );

    const image = this.hiddenCanvasContext.getImageData(0, 0, size.width, size.height);
    this.thread.adjustCanvasData(image.data, this.parameters.invertColors);
    this.hiddenCanvasContext.putImageData(image, 0, 0);

    this.computeError();
    this.initializeHiddenCanvasLineProperties();
  }

  computeError() {
    this.uploadCanvasDataToCPU();

    const width = this.hiddenCanvasData.width;
    const height = this.hiddenCanvasData.height;
    const pixels = width * height;
    const totalChannels = 3 * pixels;

    this.error = { average: 0, meanSquare: 0, variance: 0 };

    for (let i = 0; i < pixels; i++) {
      const r = 127 - this.hiddenCanvasData.data[4 * i + 0];
      const g = 127 - this.hiddenCanvasData.data[4 * i + 1];
      const b = 127 - this.hiddenCanvasData.data[4 * i + 2];

      this.error.average += r + g + b;
      this.error.meanSquare += r * r + g * g + b * b;
    }

    this.error.average = Math.round(this.error.average / totalChannels);
    this.error.meanSquare = Math.round(this.error.meanSquare / totalChannels);

    for (let i = 0; i < pixels; i++) {
      const r = 127 - this.hiddenCanvasData.data[4 * i + 0];
      const g = 127 - this.hiddenCanvasData.data[4 * i + 1];
      const b = 127 - this.hiddenCanvasData.data[4 * i + 2];

      const average = (r + g + b) / 3 - this.error.average;
      this.error.variance += average * average;
    }

    this.error.variance = Math.round(this.error.variance / totalChannels);
  }

  uploadCanvasDataToCPU() {
    if (this.hiddenCanvasData === null) {
      const width = this.hiddenCanvas.width;
      const height = this.hiddenCanvas.height;
      this.hiddenCanvasData = this.hiddenCanvasContext.getImageData(0, 0, width, height);
    }
  }

  drawSegmentOnHiddenCanvas(from, to) {
    this.hiddenCanvasContext.beginPath();
    this.hiddenCanvasContext.moveTo(from.x, from.y);
    this.hiddenCanvasContext.lineTo(to.x, to.y);
    this.hiddenCanvasContext.stroke();
    this.hiddenCanvasContext.closePath();

    this.hiddenCanvasData = null;
  }

  computeSegment(thread) {
    let startPeg;
    let nextPeg;

    if (thread.length === 0) {
      const seed = this.computeBestStartingSegment();
      thread.push(seed.peg1);
      startPeg = seed.peg1;
      nextPeg = seed.peg2;
    } else {
      startPeg = thread[thread.length - 1];
      const historyLength = Math.min(thread.length, 20);
      const recent = thread.slice(-historyLength);
      nextPeg = this.computeBestNextPeg(startPeg, recent);
    }

    thread.push(nextPeg);
    this.drawSegmentOnHiddenCanvas(startPeg, nextPeg);
  }

  computeBestStartingSegment() {
    const candidates = [];
    let bestScore = Number.NEGATIVE_INFINITY;
    const step = 1 + Math.floor(this.pegs.length / 100);

    for (let i = 0; i < this.pegs.length; i += step) {
      for (let j = i + 1; j < this.pegs.length; j += step) {
        const peg1 = this.pegs[i];
        const peg2 = this.pegs[j];

        if (this.arePegsTooClose(peg1, peg2)) {
          continue;
        }

        const score = this.computeSegmentPotential(peg1, peg2);

        if (score > bestScore) {
          bestScore = score;
          candidates.length = 0;
          candidates.push({ peg1, peg2 });
        } else if (score === bestScore) {
          candidates.push({ peg1, peg2 });
        }
      }
    }

    return ThreadingSingle.randomOne(candidates);
  }

  computeBestNextPeg(fromPeg, recentHistory) {
    const candidates = [];
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const candidate of this.pegs) {
      if (this.arePegsTooClose(fromPeg, candidate) || recentHistory.includes(candidate)) {
        continue;
      }

      const score = this.computeSegmentPotential(fromPeg, candidate);

      if (score > bestScore) {
        bestScore = score;
        candidates.length = 0;
        candidates.push(candidate);
      } else if (score === bestScore) {
        candidates.push(candidate);
      }
    }

    return ThreadingSingle.randomOne(candidates);
  }

  computeSegmentPotential(from, to) {
    this.uploadCanvasDataToCPU();

    const length = Math.hypot(from.x - to.x, from.y - to.y);
    const steps = Math.ceil(length);

    if (steps === 0) {
      return 0;
    }

    let score = 0;

    for (let i = 0; i < steps; i++) {
      const t = (i + 1) / (steps + 1);
      const samplePoint = { x: ThreadingSingle.lerp(from.x, to.x, t), y: ThreadingSingle.lerp(from.y, to.y, t) };
      score += 127 - (this.sampleCanvasData(samplePoint) + 255 * this.lineOpacityInternal);
    }

    return score / steps;
  }

  sampleCanvasData(point) {
    const width = this.hiddenCanvasData.width;
    const height = this.hiddenCanvasData.height;

    const minX = ThreadingSingle.clamp(Math.floor(point.x), 0, width - 1);
    const maxX = ThreadingSingle.clamp(Math.ceil(point.x), 0, width - 1);
    const minY = ThreadingSingle.clamp(Math.floor(point.y), 0, height - 1);
    const maxY = ThreadingSingle.clamp(Math.ceil(point.y), 0, height - 1);

    const topLeft = this.sampleCanvasPixel(minX, minY);
    const topRight = this.sampleCanvasPixel(maxX, minY);
    const bottomLeft = this.sampleCanvasPixel(minX, maxY);
    const bottomRight = this.sampleCanvasPixel(maxX, maxY);

    const fracX = point.x % 1;
    const fracY = point.y % 1;

    const top = ThreadingSingle.lerp(topLeft, topRight, fracX);
    const bottom = ThreadingSingle.lerp(bottomLeft, bottomRight, fracX);

    return ThreadingSingle.lerp(top, bottom, fracY);
  }

  sampleCanvasPixel(x, y) {
    const index = 4 * (x + y * this.hiddenCanvasData.width);
    return this.thread.sampleCanvas(this.hiddenCanvasData.data, index);
  }

  computePegs() {
    const referenceSize = 1000;
    const ratio = this.hiddenCanvas.width / this.hiddenCanvas.height;
    const targetSize =
      ratio > 1
        ? { width: referenceSize, height: Math.round(referenceSize / ratio) }
        : { width: Math.round(referenceSize * ratio), height: referenceSize };

    const pegs = [];

    if (this.parameters.shape === "rectangle") {
      this.arePegsTooClose = (a, b) => a.x === b.x || a.y === b.y;

      const width = targetSize.width;
      const height = targetSize.height;
      const ratioHeight = height / width;
      const horizontalCount = Math.round(0.5 * this.parameters.pegsCount / (1 + ratioHeight));
      const verticalCount = Math.round(0.5 * (this.parameters.pegsCount - 2 * horizontalCount));

      pegs.push({ x: 0, y: 0 });

      for (let i = 1; i < horizontalCount; i++) {
        pegs.push({ x: width * (i / horizontalCount), y: 0 });
      }

      pegs.push({ x: width, y: 0 });

      for (let i = 1; i < verticalCount; i++) {
        pegs.push({ x: width, y: height * (i / verticalCount) });
      }

      pegs.push({ x: width, y: height });

      for (let i = horizontalCount - 1; i >= 1; i--) {
        pegs.push({ x: width * (i / horizontalCount), y: height });
      }

      pegs.push({ x: 0, y: height });

      for (let i = verticalCount - 1; i >= 1; i--) {
        pegs.push({ x: 0, y: height * (i / verticalCount) });
      }
    } else {
      this.arePegsTooClose = (a, b) => {
        const delta = Math.abs(a.angle - b.angle);
        return Math.min(delta, ThreadingSingle.TWO_PI - delta) <= ThreadingSingle.MIN_SEGMENT_DISTANCE;
      };

      const radius = 0.5 * Math.min(targetSize.width, targetSize.height);
      const centerX = 0.5 * targetSize.width;
      const centerY = 0.5 * targetSize.height;
      const angleStep = ThreadingSingle.TWO_PI / this.parameters.pegsCount;

      for (let i = 0; i < this.parameters.pegsCount; i++) {
        const angle = i * angleStep;
        pegs.push({
          x: centerX + radius * Math.cos(angle),
          y: centerY + radius * Math.sin(angle),
          angle,
        });
      }
    }

    for (const peg of pegs) {
      peg.x *= this.hiddenCanvas.width / targetSize.width;
      peg.y *= this.hiddenCanvas.height / targetSize.height;
    }

    return pegs;
  }

  static now() {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return () => performance.now();
    }
    return () => Date.now();
  }

  static clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  static lerp(a, b, t) {
    return a * (1 - t) + b * t;
  }

  static randomOne(array) {
    if (!array.length) {
      return null;
    }

    const index = Math.floor(Math.random() * array.length);
    return array[index];
  }

  static computeBestSize(image, target) {
    const ratio = target / Math.max(image.width, image.height);
    return {
      width: Math.ceil(image.width * ratio),
      height: Math.ceil(image.height * ratio),
    };
  }

  static rawColorChannels(color) {
    switch (color) {
      case ThreadingSingle.EColor.MONOCHROME:
        return { r: 1, g: 1, b: 1 };
      case ThreadingSingle.EColor.RED:
        return { r: 1, g: 0, b: 0 };
      case ThreadingSingle.EColor.GREEN:
        return { r: 0, g: 1, b: 0 };
      case ThreadingSingle.EColor.BLUE:
        return { r: 0, g: 0, b: 1 };
      default:
        return { r: 1, g: 1, b: 1 };
    }
  }

  static resetCanvasCompositing(context) {
    context.globalCompositeOperation = "source-over";
  }

  static applyCanvasCompositing(context, color, opacity, operation) {
    const channels = ThreadingSingle.rawColorChannels(color);

    if (ThreadingSingle.#advancedCompositingSupported) {
      const operationName =
        operation === ThreadingSingle.ECompositingOperation.LIGHTEN ? "lighter" : "difference";

      context.globalCompositeOperation = operationName;

      if (context.globalCompositeOperation === operationName) {
        const intensity = Math.ceil(255 * opacity);
        context.strokeStyle = `rgb(${channels.r * intensity}, ${channels.g * intensity}, ${channels.b * intensity})`;
        return;
      }

      ThreadingSingle.#advancedCompositingSupported = false;
    }

    ThreadingSingle.resetCanvasCompositing(context);

    if (operation === ThreadingSingle.ECompositingOperation.DARKEN) {
      channels.r = 1 - channels.r;
      channels.g = 1 - channels.g;
      channels.b = 1 - channels.b;
    }

    context.strokeStyle = `rgba(${255 * channels.r}, ${255 * channels.g}, ${255 * channels.b}, ${opacity})`;
  }
}

ThreadingSingle.TWO_PI = Math.PI * 2;
ThreadingSingle.MIN_SEGMENT_DISTANCE = ThreadingSingle.TWO_PI / 16;

ThreadingSingle.ThreadBase = class {
  constructor() {
    this.sampleCanvas = null;
  }

  static lowerNbSegmentsForThread(thread, nbSegments) {
    thread.length = nbSegments > 0 ? Math.min(thread.length, nbSegments + 1) : 0;
  }

  static computeNbSegments(thread) {
    return thread.length > 1 ? thread.length - 1 : 0;
  }

  static iterateOnThread(thread, color, fromIndex, callback) {
    if (fromIndex < ThreadingSingle.ThreadBase.computeNbSegments(thread)) {
      callback(thread.slice(fromIndex), color);
    }
  }
};

ThreadingSingle.ThreadMonochrome = class extends ThreadingSingle.ThreadBase {
  constructor() {
    super();
    this.threadPegs = [];
  }

  get totalNbSegments() {
    return ThreadingSingle.ThreadBase.computeNbSegments(this.threadPegs);
  }

  lowerNbSegments(nbSegments) {
    ThreadingSingle.ThreadBase.lowerNbSegmentsForThread(this.threadPegs, nbSegments);
  }

  iterateOnThreads(fromIndex, callback) {
    ThreadingSingle.ThreadBase.iterateOnThread(
      this.threadPegs,
      ThreadingSingle.EColor.MONOCHROME,
      fromIndex,
      callback
    );
  }

  getThreadToGrow() {
    return { thread: this.threadPegs, color: ThreadingSingle.EColor.MONOCHROME };
  }

  adjustCanvasData(data, invertColors) {
    const normalize = invertColors ? (value) => (255 - value) / 2 : (value) => value / 2;
    const pixels = data.length / 4;

    for (let i = 0; i < pixels; i++) {
      const average = normalize((data[4 * i + 0] + data[4 * i + 1] + data[4 * i + 2]) / 3);
      data[4 * i + 0] = average;
      data[4 * i + 1] = average;
      data[4 * i + 2] = average;
    }
  }

  enableSamplingFor() {
    if (this.sampleCanvas === null) {
      this.sampleCanvas = (data, offset) => data[offset + 0];
    }
  }
};

ThreadingSingle.ThreadRedBlueGreen = class extends ThreadingSingle.ThreadBase {
  constructor() {
    super();
    this.threadPegsRed = [];
    this.threadPegsGreen = [];
    this.threadPegsBlue = [];

    this.frequencyRed = 1 / 3;
    this.frequencyGreen = 1 / 3;
    this.frequencyBlue = 1 / 3;
  }

  get totalNbSegments() {
    return (
      ThreadingSingle.ThreadBase.computeNbSegments(this.threadPegsRed) +
      ThreadingSingle.ThreadBase.computeNbSegments(this.threadPegsGreen) +
      ThreadingSingle.ThreadBase.computeNbSegments(this.threadPegsBlue)
    );
  }

  lowerNbSegments(nbSegments) {
    const repartition = this.computeIdealSegmentsRepartition(nbSegments);
    ThreadingSingle.ThreadBase.lowerNbSegmentsForThread(this.threadPegsRed, repartition.red);
    ThreadingSingle.ThreadBase.lowerNbSegmentsForThread(this.threadPegsGreen, repartition.green);
    ThreadingSingle.ThreadBase.lowerNbSegmentsForThread(this.threadPegsBlue, repartition.blue);
  }

  iterateOnThreads(fromIndex, callback) {
    const repartition = this.computeIdealSegmentsRepartition(fromIndex);
    ThreadingSingle.ThreadBase.iterateOnThread(this.threadPegsRed, ThreadingSingle.EColor.RED, repartition.red, callback);
    ThreadingSingle.ThreadBase.iterateOnThread(
      this.threadPegsGreen,
      ThreadingSingle.EColor.GREEN,
      repartition.green,
      callback
    );
    ThreadingSingle.ThreadBase.iterateOnThread(
      this.threadPegsBlue,
      ThreadingSingle.EColor.BLUE,
      repartition.blue,
      callback
    );
  }

  getThreadToGrow() {
    const target = this.computeIdealSegmentsRepartition(this.totalNbSegments + 1);

    if (target.red > 0 && this.threadPegsRed.length < target.red + 1) {
      return { thread: this.threadPegsRed, color: ThreadingSingle.EColor.RED };
    }

    if (target.green > 0 && this.threadPegsGreen.length < target.green + 1) {
      return { thread: this.threadPegsGreen, color: ThreadingSingle.EColor.GREEN };
    }

    return { thread: this.threadPegsBlue, color: ThreadingSingle.EColor.BLUE };
  }

  adjustCanvasData(data, invertColors) {
    let sumRed = 0;
    let sumGreen = 0;
    let sumBlue = 0;

    const normalize = invertColors ? (value) => (255 - value) / 2 : (value) => value / 2;
    const pixels = data.length / 4;

    for (let i = 0; i < pixels; i++) {
      sumRed += data[4 * i + 0];
      sumGreen += data[4 * i + 1];
      sumBlue += data[4 * i + 2];

      data[4 * i + 0] = normalize(data[4 * i + 0]);
      data[4 * i + 1] = normalize(data[4 * i + 1]);
      data[4 * i + 2] = normalize(data[4 * i + 2]);
    }

    if (!invertColors) {
      sumRed = 255 * pixels - sumRed;
      sumGreen = 255 * pixels - sumGreen;
      sumBlue = 255 * pixels - sumBlue;
    }

    const total = sumRed + sumGreen + sumBlue || 1;

    this.frequencyRed = sumRed / total;
    this.frequencyGreen = sumGreen / total;
    this.frequencyBlue = sumBlue / total;
  }

  enableSamplingFor(color) {
    const offset = color === ThreadingSingle.EColor.RED ? 0 : color === ThreadingSingle.EColor.GREEN ? 1 : 2;
    this.sampleCanvas = (data, index) => data[index + offset];
  }

  computeIdealSegmentsRepartition(count) {
    const targetRed = count * this.frequencyRed;
    const targetGreen = count * this.frequencyGreen;
    const targetBlue = count * this.frequencyBlue;

    const repartition = {
      red: Math.floor(targetRed),
      green: Math.floor(targetGreen),
      blue: Math.floor(targetBlue),
    };

    while (repartition.red + repartition.green + repartition.blue < count) {
      const total = Math.max(1, repartition.red + repartition.green + repartition.blue);
      const deltaRed = targetRed - repartition.red / total;
      const deltaGreen = targetGreen - repartition.green / total;
      const deltaBlue = targetBlue - repartition.blue / total;

      if (deltaRed >= deltaGreen && deltaRed >= deltaBlue) {
        repartition.red++;
      } else if (deltaGreen >= deltaRed && deltaGreen >= deltaBlue) {
        repartition.green++;
      } else {
        repartition.blue++;
      }
    }

    return repartition;
  }
};

ThreadingSingle.Transformation = class {
  constructor(destinationSize, sourceCanvas) {
    const scaleX = destinationSize.width / sourceCanvas.width;
    const scaleY = destinationSize.height / sourceCanvas.height;

    this.scaling = Math.min(scaleX, scaleY);
    this.origin = {
      x: 0.5 * (destinationSize.width - this.scaling * sourceCanvas.width),
      y: 0.5 * (destinationSize.height - this.scaling * sourceCanvas.height),
    };
  }

  transform(point) {
    return {
      x: this.origin.x + point.x * this.scaling,
      y: this.origin.y + point.y * this.scaling,
    };
  }
};

window.ThreadingSingle = ThreadingSingle;
