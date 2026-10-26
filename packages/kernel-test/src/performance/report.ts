import * as Plot from '@observablehq/plot';
import { JSDOM } from 'jsdom';
import type { SvgElement } from 'jsdom';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Reference categorical palette, light surface, in its fixed order. Every
// chart has at most four series. Aqua and yellow fall below 3:1 against the
// surface, so every chart carries a text legend and a table beside it.
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'];
const SURFACE = '#fcfcfb';
const TEXT = '#0b0b0b';
const TEXT_SECONDARY = '#52514e';

const WIDTH = 720;
const HEIGHT = 360;
const LEGEND_HEIGHT = 44;

type Stats = { p50: number; p95: number; p99: number };

type KrefScalingReport = {
  platform: Record<string, unknown>;
  results: {
    vats: number;
    target: number;
    krefs: number;
    dbBytes: number;
    rssBytes: number;
    kernelToVatMs: Stats;
    vatToVatMs: Stats;
  }[];
};

type ConcurrentLoadReport = {
  platform: Record<string, unknown>;
  krefs: number;
  results: {
    vats: number;
    route: string;
    concurrency: number;
    messagesPerSecond: number;
    latencyMs: Stats;
  }[];
};

type Snapshot = {
  objects: number;
  promises: number;
  clistRows: number;
  vatstoreRows: number;
};

type GcReport = {
  platform: Record<string, unknown>;
  workload: string;
  krefs: number;
  pairs: number;
  concurrency: number;
  results: { round: number; messages: number; collected: Snapshot }[];
};

type Point = { series: string; x: number; y: number; dashed?: boolean };

type ChartOptions = {
  title: string;
  x: { label: string; type?: 'linear' | 'log' };
  y: { label: string; type?: 'linear' | 'log' };
  points: Point[];
  /** Series in legend order, which fixes each one's color. */
  series: string[];
};

/**
 * Render a line chart as a standalone SVG, with a legend above the plot.
 *
 * @param options - The chart.
 * @returns The SVG's source.
 */
function renderLineChart(options: ChartOptions): string {
  const { document } = new JSDOM('').window;
  const colors = new Map(
    options.series.map((name, index) => [name, PALETTE[index] as string]),
  );
  const markOptions = {
    x: 'x',
    y: 'y',
    z: (point: Point) => `${point.series}${point.dashed ? ' dashed' : ''}`,
  };
  const solid = options.points.filter((point) => !point.dashed);
  const dashed = options.points.filter((point) => point.dashed);
  const svg = Plot.plot({
    document,
    width: WIDTH,
    height: HEIGHT,
    marginTop: 20 + LEGEND_HEIGHT,
    marginLeft: 64,
    marginRight: 24,
    style: {
      background: SURFACE,
      color: TEXT_SECONDARY,
      fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
      fontSize: '12px',
    },
    x: { type: options.x.type ?? 'linear', label: options.x.label },
    y: {
      type: options.y.type ?? 'linear',
      label: options.y.label,
      labelAnchor: 'center',
      labelArrow: 'none',
      grid: true,
      zero: options.y.type !== 'log',
      // Plain numbers: Plot's default for a log axis has SI prefixes, so
      // 0.1 MiB would read "100m".
      ...(options.y.type === 'log' ? { tickFormat: '~g' } : {}),
    },
    color: { domain: options.series, range: PALETTE },
    marks: [
      Plot.line(solid, { ...markOptions, stroke: 'series', strokeWidth: 2 }),
      Plot.line(dashed, {
        ...markOptions,
        stroke: 'series',
        strokeWidth: 2,
        strokeDasharray: '5,4',
      }),
      // Markers ringed in the surface color, so overlapping series stay
      // distinct.
      Plot.dot(options.points, {
        x: 'x',
        y: 'y',
        fill: 'series',
        r: 4,
        stroke: SURFACE,
        strokeWidth: 2,
      }),
    ],
  }) as unknown as SvgElement;

  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const svgNs = 'http://www.w3.org/2000/svg';
  const add = (
    parent: SvgElement,
    tag: string,
    attributes: Record<string, string | number>,
    text?: string,
  ): SvgElement => {
    const element = document.createElementNS(svgNs, tag);
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, String(value));
    }
    if (text !== undefined) {
      element.textContent = text;
    }
    parent.append(element);
    return element;
  };

  const legend = add(svg, 'g', { 'font-size': 12, 'text-anchor': 'start' });
  add(
    legend,
    'text',
    { x: 12, y: 18, fill: TEXT, 'font-size': 14, 'font-weight': 600 },
    options.title,
  );
  let cursor = 12;
  for (const name of options.series) {
    add(legend, 'line', {
      x1: cursor,
      x2: cursor + 18,
      y1: 38,
      y2: 38,
      stroke: colors.get(name) as string,
      'stroke-width': 3,
      'stroke-linecap': 'round',
    });
    add(legend, 'text', { x: cursor + 24, y: 42, fill: TEXT }, name);
    // About 7 px a character at this size.
    cursor += 24 + name.length * 7 + 20;
  }
  if (dashed.length > 0) {
    add(legend, 'line', {
      x1: cursor,
      x2: cursor + 18,
      y1: 38,
      y2: 38,
      stroke: TEXT_SECONDARY,
      'stroke-width': 2,
      'stroke-dasharray': '5,4',
    });
    add(legend, 'text', { x: cursor + 24, y: 42, fill: TEXT_SECONDARY }, 'p95');
  }
  return `${svg.outerHTML}\n`;
}

/**
 * Render rows as a Markdown table.
 *
 * @param headers - The column headers.
 * @param rows - The cells, row by row.
 * @param textColumns - How many leading columns hold text, which are
 * left-aligned; the rest are right-aligned.
 * @returns The table.
 */
function table(headers: string[], rows: string[][], textColumns = 1): string {
  const align = headers.map((_, index) =>
    index < textColumns ? '---' : '---:',
  );
  return [headers, align, ...rows]
    .map((cells) => `| ${cells.join(' | ')} |`)
    .join('\n');
}

const fixed = (value: number, digits = 1): string => value.toFixed(digits);
const count = (value: number): string => value.toLocaleString('en-US');
const mib = (bytes: number): string => fixed(bytes / 2 ** 20);
const gib = (bytes: number): string => fixed(bytes / 2 ** 30, 2);
const slug = (route: string): string =>
  route === 'kernel→vat' ? 'kernel-to-vat' : 'vat-to-vat';

/**
 * Read the reports a run wrote whose names start with a prefix.
 *
 * @param runDir - The run's directory.
 * @param prefix - The profile's name.
 * @returns The reports, by file name.
 */
async function readReports<Report>(
  runDir: string,
  prefix: string,
): Promise<Map<string, Report>> {
  const names = (await readdir(runDir))
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort();
  const reports = new Map<string, Report>();
  for (const name of names) {
    reports.set(
      name.slice(prefix.length, -'.json'.length),
      JSON.parse(await readFile(path.join(runDir, name), 'utf8')) as Report,
    );
  }
  return reports;
}

/**
 * Write a chart and return the Markdown that shows it.
 *
 * @param chartDir - Where charts go.
 * @param name - The chart's file name, less its extension.
 * @param options - The chart.
 * @returns The Markdown image.
 */
async function chart(
  chartDir: string,
  name: string,
  options: ChartOptions,
): Promise<string> {
  await writeFile(path.join(chartDir, `${name}.svg`), renderLineChart(options));
  return `![${options.title}](charts/${name}.svg)`;
}

/**
 * Render the kref scaling section.
 *
 * @param reports - One report per vat count.
 * @param chartDir - Where charts go.
 * @returns The section.
 */
async function krefScalingSection(
  reports: KrefScalingReport[],
  chartDir: string,
): Promise<string> {
  const rows = reports.flatMap((report) => report.results);
  const series = [...new Set(rows.map((row) => `${row.vats} vats`))];
  const points = (measure: (row: (typeof rows)[number]) => number): Point[] =>
    rows.map((row) => ({
      series: `${row.vats} vats`,
      // Measured, not the target: spread over many pairs, a small target
      // rounds up per pair, and every vat's root is a kref too.
      x: row.krefs,
      y: measure(row),
    }));
  const latency = (route: 'kernelToVatMs' | 'vatToVatMs'): Point[] => [
    ...points((row) => row[route].p50),
    ...points((row) => row[route].p95).map((point) => ({
      ...point,
      dashed: true,
    })),
  ];
  const lastRows = reports
    .map((report) => report.results.at(-1))
    .filter((row) => row !== undefined);
  return [
    '## Delivery against live krefs',
    '',
    'One message at a time, to holder vats whose c-lists hold the krefs. Solid lines are p50, dashed p95.',
    '',
    await chart(chartDir, 'kref-latency-kernel-to-vat', {
      title: 'Kernel→vat round trip',
      x: { label: 'live krefs', type: 'log' },
      y: { label: 'ms' },
      points: latency('kernelToVatMs'),
      series,
    }),
    '',
    await chart(chartDir, 'kref-latency-vat-to-vat', {
      title: 'Vat→vat round trip',
      x: { label: 'live krefs', type: 'log' },
      y: { label: 'ms' },
      points: latency('vatToVatMs'),
      series,
    }),
    '',
    await chart(chartDir, 'kref-database-size', {
      title: 'Kernel database size',
      x: { label: 'live krefs', type: 'log' },
      y: { label: 'MiB', type: 'log' },
      points: points((row) => row.dbBytes / 2 ** 20),
      series,
    }),
    '',
    await chart(chartDir, 'kref-memory', {
      title: 'Resident memory, kernel and vats',
      x: { label: 'live krefs', type: 'log' },
      y: { label: 'GiB' },
      points: points((row) => row.rssBytes / 2 ** 30),
      series,
    }),
    '',
    table(
      [
        'vats',
        'krefs',
        'db MiB',
        'rss GiB',
        'kernel→vat p50 ms',
        'p95',
        'vat→vat p50 ms',
        'p95',
      ],
      lastRows.map((row) => [
        String(row.vats),
        count(row.krefs),
        mib(row.dbBytes),
        gib(row.rssBytes),
        fixed(row.kernelToVatMs.p50, 2),
        fixed(row.kernelToVatMs.p95, 2),
        fixed(row.vatToVatMs.p50, 2),
        fixed(row.vatToVatMs.p95, 2),
      ]),
    ),
  ].join('\n');
}

/**
 * Render the concurrent load section.
 *
 * @param reports - One report per vat count.
 * @param chartDir - Where charts go.
 * @returns The section.
 */
async function concurrentLoadSection(
  reports: ConcurrentLoadReport[],
  chartDir: string,
): Promise<string> {
  const rows = reports.flatMap((report) => report.results);
  const series = [...new Set(rows.map((row) => `${row.vats} vats`))];
  const routes = [...new Set(rows.map((row) => row.route))];
  const krefs = reports[0]?.krefs ?? 0;
  const parts = [
    '## Concurrent load',
    '',
    `${count(krefs)} live krefs. Each client sends its next message when its last is answered.`,
  ];
  for (const route of routes) {
    const routeRows = rows.filter((row) => row.route === route);
    parts.push(
      '',
      await chart(chartDir, `load-throughput-${slug(route)}`, {
        title: `${route} throughput`,
        x: { label: 'concurrent clients', type: 'log' },
        y: { label: 'messages / s' },
        points: routeRows.map((row) => ({
          series: `${row.vats} vats`,
          x: row.concurrency,
          y: row.messagesPerSecond,
        })),
        series,
      }),
      '',
      await chart(chartDir, `load-latency-${slug(route)}`, {
        title: `${route} latency`,
        x: { label: 'concurrent clients', type: 'log' },
        y: { label: 'ms', type: 'log' },
        points: routeRows.flatMap((row) => [
          {
            series: `${row.vats} vats`,
            x: row.concurrency,
            y: row.latencyMs.p50,
          },
          {
            series: `${row.vats} vats`,
            x: row.concurrency,
            y: row.latencyMs.p95,
            dashed: true,
          },
        ]),
        series,
      }),
    );
  }
  const peakRows = reports.flatMap((report) =>
    routes.flatMap((route) => {
      const routeRows = report.results.filter((row) => row.route === route);
      // A run that died partway leaves reports missing some routes.
      if (routeRows.length === 0) {
        return [];
      }
      const peak = routeRows.reduce((best, row) =>
        row.messagesPerSecond > best.messagesPerSecond ? row : best,
      );
      const busiest = routeRows.reduce((most, row) =>
        row.concurrency > most.concurrency ? row : most,
      );
      return [
        [
          String(peak.vats),
          route,
          `${fixed(peak.messagesPerSecond, 0)} at ${peak.concurrency}`,
          `${fixed(busiest.messagesPerSecond, 0)} at ${busiest.concurrency}`,
          fixed(busiest.latencyMs.p50, 1),
          fixed(busiest.latencyMs.p95, 1),
        ],
      ];
    }),
  );
  parts.push(
    '',
    table(
      [
        'vats',
        'route',
        'peak msgs/s at clients',
        'msgs/s at most clients',
        'p50 ms there',
        'p95 ms there',
      ],
      peakRows,
      2,
    ),
  );
  return parts.join('\n');
}

/**
 * Render the garbage collection section.
 *
 * @param reports - One report per workload.
 * @param chartDir - Where charts go.
 * @returns The section.
 */
async function gcSection(
  reports: GcReport[],
  chartDir: string,
): Promise<string> {
  const series = reports.map((report) => report.workload);
  const points = (field: keyof Snapshot): Point[] =>
    reports.flatMap((report) =>
      report.results.map((result) => ({
        series: report.workload,
        x: result.messages,
        y: result.collected[field],
      })),
    );
  const first = reports[0];
  return [
    '## Garbage collection under load',
    '',
    `Rounds of one workload at a time over ${first?.pairs ?? 0} holder/minter pairs holding ${count(first?.krefs ?? 0)} krefs, ${first?.concurrency ?? 0} clients at once, with every vat reaped after each round. What remains above the pre-load baseline after collection, discounting what collecting itself leaves:`,
    '',
    await chart(chartDir, 'gc-leaked-promises', {
      title: 'Promises left after collection',
      x: { label: 'messages sent' },
      y: { label: 'promises' },
      points: points('promises'),
      series,
    }),
    '',
    await chart(chartDir, 'gc-leaked-objects', {
      title: 'Objects left after collection',
      x: { label: 'messages sent' },
      y: { label: 'objects' },
      points: points('objects'),
      series,
    }),
    '',
    table(
      [
        'workload',
        'messages',
        'objects / message',
        'promises / message',
        'c-list rows / message',
        'vatstore rows / message',
      ],
      reports.map((report) => {
        const last = report.results.at(-1);
        const perMessage = (field: keyof Snapshot): string =>
          last ? fixed(last.collected[field] / last.messages, 2) : '';
        return [
          report.workload,
          count(last?.messages ?? 0),
          perMessage('objects'),
          perMessage('promises'),
          perMessage('clistRows'),
          perMessage('vatstoreRows'),
        ];
      }),
    ),
  ].join('\n');
}

/**
 * Chart a performance run's reports and collect the charts and tables into
 * `REPORT.md` in the run's directory.
 *
 * @param runDir - The run's directory.
 * @returns The report's path, or undefined if the run wrote no reports.
 */
export async function renderReport(
  runDir: string,
): Promise<string | undefined> {
  const chartDir = path.join(runDir, 'charts');
  await mkdir(chartDir, { recursive: true });
  const byVats = <Report extends { results: { vats: number }[] }>(
    reports: Map<string, Report>,
  ): Report[] =>
    [...reports.values()].sort(
      (a, b) => (a.results[0]?.vats ?? 0) - (b.results[0]?.vats ?? 0),
    );
  const krefScaling = byVats(
    await readReports<KrefScalingReport>(runDir, 'kref-scaling-'),
  );
  const concurrentLoad = byVats(
    await readReports<ConcurrentLoadReport>(runDir, 'concurrent-load-'),
  );
  const workloads = ['ping', 'pingHeld', 'churn', 'fetch'];
  const gc = [
    ...(await readReports<GcReport>(runDir, 'gc-under-load-')).values(),
  ].sort(
    (a, b) => workloads.indexOf(a.workload) - workloads.indexOf(b.workload),
  );

  const platform =
    krefScaling[0]?.platform ?? concurrentLoad[0]?.platform ?? gc[0]?.platform;
  if (!platform) {
    return undefined;
  }
  const sections = [
    '# Kernel performance',
    '',
    `Run \`${path.basename(runDir)}\` on ${String(platform.cpu)} (${String(platform.cpus)} cores, ${gib(Number(platform.memoryBytes))} GiB), ${String(platform.os)}, Node ${String(platform.node)}, ${String(platform.store)}.`,
  ];
  if (krefScaling.length > 0) {
    sections.push('', await krefScalingSection(krefScaling, chartDir));
  }
  if (concurrentLoad.length > 0) {
    sections.push('', await concurrentLoadSection(concurrentLoad, chartDir));
  }
  if (gc.length > 0) {
    sections.push('', await gcSection(gc, chartDir));
  }
  const reportPath = path.join(runDir, 'REPORT.md');
  await writeFile(reportPath, `${sections.join('\n')}\n`);
  return reportPath;
}

/**
 * The directory of the most recent run.
 *
 * @param runsDir - Where runs are kept.
 * @returns The directory.
 */
async function latestRun(runsDir: string): Promise<string> {
  const runs = (await readdir(runsDir)).sort();
  const latest = runs.at(-1);
  if (latest === undefined) {
    throw new Error(`No runs in ${runsDir}`);
  }
  return path.join(runsDir, latest);
}

export const RUNS_DIR = fileURLToPath(
  new URL('../../logs/performance/runs/', import.meta.url),
);

// `node src/performance/report.ts [run directory]` renders a run again, by
// default the latest.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runDir = process.argv[2] ?? (await latestRun(RUNS_DIR));
  const reportPath = await renderReport(runDir);
  process.stdout.write(`${reportPath ?? `No reports in ${runDir}`}\n`);
}
