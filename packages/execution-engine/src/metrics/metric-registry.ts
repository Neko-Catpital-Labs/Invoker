export type MetricLabels = Readonly<Record<string, string>>;

export type MetricKind = 'counter' | 'gauge' | 'histogram';

interface MetricDefinition {
  readonly name: string;
  readonly kind: MetricKind;
  readonly help: string;
}

interface Sample {
  readonly labels: MetricLabels;
  value: number;
}

interface HistogramSample {
  readonly labels: MetricLabels;
  readonly buckets: readonly number[];
  counts: number[];
  count: number;
  sum: number;
}

const DEFAULT_HISTOGRAM_BUCKETS = [
  0.005,
  0.01,
  0.025,
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2.5,
  5,
  10,
] as const;

function labelsKey(labels: MetricLabels): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}\u0000${value}`)
    .join('\u0001');
}

function renderLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return '';
  const rendered = entries
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
    .join(',');
  return `{${rendered}}`;
}

function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function renderValue(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(value);
}

export class MetricRegistry {
  private readonly definitions = new Map<string, MetricDefinition>();
  private readonly scalarSamples = new Map<string, Map<string, Sample>>();
  private readonly histogramSamples = new Map<string, Map<string, HistogramSample>>();

  incrementCounter(name: string, labels: MetricLabels, amount = 1, help = name): number {
    if (amount < 0) {
      throw new Error(`Counter ${name} cannot be incremented by a negative amount`);
    }
    this.define(name, 'counter', help);
    const sample = this.scalarSampleFor(name, labels);
    sample.value += amount;
    return sample.value;
  }

  setGauge(name: string, labels: MetricLabels, value: number, help = name): number {
    this.define(name, 'gauge', help);
    const sample = this.scalarSampleFor(name, labels);
    sample.value = value;
    return sample.value;
  }

  observeHistogram(
    name: string,
    labels: MetricLabels,
    value: number,
    help = name,
    buckets: readonly number[] = DEFAULT_HISTOGRAM_BUCKETS,
  ): void {
    this.define(name, 'histogram', help);
    const sample = this.histogramSampleFor(name, labels, buckets);
    sample.count += 1;
    sample.sum += value;
    sample.counts = sample.counts.map((count, index) => (
      value <= sample.buckets[index] ? count + 1 : count
    ));
  }

  getValue(name: string, labels: MetricLabels): number | undefined {
    return this.scalarSamples.get(name)?.get(labelsKey(labels))?.value;
  }

  getHistogram(name: string, labels: MetricLabels): { count: number; sum: number } | undefined {
    const sample = this.histogramSamples.get(name)?.get(labelsKey(labels));
    if (!sample) return undefined;
    return { count: sample.count, sum: sample.sum };
  }

  renderPrometheusText(): string {
    const lines: string[] = [];
    for (const definition of [...this.definitions.values()].sort((left, right) => left.name.localeCompare(right.name))) {
      lines.push(`# HELP ${definition.name} ${definition.help}`);
      lines.push(`# TYPE ${definition.name} ${definition.kind}`);
      if (definition.kind === 'histogram') {
        this.renderHistogram(lines, definition.name);
      } else {
        this.renderScalar(lines, definition.name);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  private define(name: string, kind: MetricKind, help: string): void {
    const existing = this.definitions.get(name);
    if (existing) {
      if (existing.kind !== kind) {
        throw new Error(`Metric ${name} already defined as ${existing.kind}`);
      }
      return;
    }
    this.definitions.set(name, { name, kind, help });
  }

  private scalarSampleFor(name: string, labels: MetricLabels): Sample {
    let samples = this.scalarSamples.get(name);
    if (!samples) {
      samples = new Map();
      this.scalarSamples.set(name, samples);
    }
    const key = labelsKey(labels);
    let sample = samples.get(key);
    if (!sample) {
      sample = { labels, value: 0 };
      samples.set(key, sample);
    }
    return sample;
  }

  private histogramSampleFor(name: string, labels: MetricLabels, buckets: readonly number[]): HistogramSample {
    let samples = this.histogramSamples.get(name);
    if (!samples) {
      samples = new Map();
      this.histogramSamples.set(name, samples);
    }
    const key = labelsKey(labels);
    let sample = samples.get(key);
    if (!sample) {
      sample = { labels, buckets, counts: buckets.map(() => 0), count: 0, sum: 0 };
      samples.set(key, sample);
    }
    return sample;
  }

  private renderScalar(lines: string[], name: string): void {
    const samples = [...(this.scalarSamples.get(name)?.values() ?? [])]
      .sort((left, right) => labelsKey(left.labels).localeCompare(labelsKey(right.labels)));
    for (const sample of samples) {
      lines.push(`${name}${renderLabels(sample.labels)} ${renderValue(sample.value)}`);
    }
  }

  private renderHistogram(lines: string[], name: string): void {
    const samples = [...(this.histogramSamples.get(name)?.values() ?? [])]
      .sort((left, right) => labelsKey(left.labels).localeCompare(labelsKey(right.labels)));
    for (const sample of samples) {
      for (const [index, bucket] of sample.buckets.entries()) {
        lines.push(`${name}_bucket${renderLabels({ ...sample.labels, le: String(bucket) })} ${sample.counts[index]}`);
      }
      lines.push(`${name}_bucket${renderLabels({ ...sample.labels, le: '+Inf' })} ${sample.count}`);
      lines.push(`${name}_sum${renderLabels(sample.labels)} ${renderValue(sample.sum)}`);
      lines.push(`${name}_count${renderLabels(sample.labels)} ${sample.count}`);
    }
  }
}
