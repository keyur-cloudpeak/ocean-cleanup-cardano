import PDFDocument from 'pdfkit';

const PRIMARY = '#2E9E9B';
const MUTED = '#5b6b73';
const BORDER = '#d8e1e5';
const DARK = '#0f172a';
const ROW_HEIGHT = 18;

function fmtDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function shortHash(hash) {
  if (!hash) return '—';
  return hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;
}

function tally(rows, keyFn) {
  const counts = new Map();
  rows.forEach((row) => {
    const key = keyFn(row);
    if (!key) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function ensureSpace(doc, needed, onNewPage) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) {
    doc.addPage();
    if (onNewPage) onNewPage();
  }
}

function sectionTitle(doc, title) {
  ensureSpace(doc, 34);
  doc.fontSize(12).fillColor(DARK).text(title, doc.page.margins.left, doc.y);
  doc.moveDown(0.35);
}

function table(doc, { columns, rows }) {
  const startX = doc.page.margins.left;
  const tableWidth = columns.reduce((sum, col) => sum + col.width, 0);

  function drawHeader() {
    let x = startX;
    const y = doc.y;
    doc.fontSize(8.5).fillColor(MUTED);
    columns.forEach((col) => {
      doc.text(col.label.toUpperCase(), x, y, { width: col.width, ellipsis: true });
      x += col.width;
    });
    doc.y = y + 12;
    doc.moveTo(startX, doc.y).lineTo(startX + tableWidth, doc.y).strokeColor(BORDER).stroke();
    doc.y += 5;
  }

  ensureSpace(doc, ROW_HEIGHT * 2);
  drawHeader();

  rows.forEach((row) => {
    ensureSpace(doc, ROW_HEIGHT, drawHeader);
    let x = startX;
    const y = doc.y;
    doc.fontSize(9).fillColor(DARK);
    row.forEach((cell, i) => {
      doc.text(String(cell), x, y, { width: columns[i].width, ellipsis: true });
      x += columns[i].width;
    });
    doc.y = y + ROW_HEIGHT;
  });

  doc.moveDown(0.6);
}

/**
 * streamContributorReportPdf — writes a contributor field report PDF
 * straight to `res` (an Express response, or any writable stream).
 */
export function streamContributorReportPdf(res, { contributor, from, to, summary, activities }) {
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  doc.pipe(res);

  const contributorName = [contributor?.firstName, contributor?.lastName].filter(Boolean).join(' ') || 'Contributor';
  const jobTitle = contributor?.jobTitle;

  doc.fontSize(20).fillColor(DARK).text('BlueMind Field Report');
  doc.moveDown(0.25);
  doc.fontSize(11).fillColor(MUTED).text(`${contributorName}${jobTitle ? ` · ${jobTitle}` : ''}`);
  doc.text(`Report period: ${fmtDate(from)} – ${fmtDate(to)}`);
  doc.text(`Generated: ${fmtDate(new Date())}`);
  doc.moveDown(0.8);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor(BORDER).stroke();
  doc.moveDown(0.8);

  const totalKg = activities.reduce((sum, a) => sum + Number(a.quantity || 0), 0);
  const hazardSites = activities.filter((a) => a.hazards.medical || a.hazards.chemical || a.hazards.unstable).length;
  const speciesSightings = activities.filter((a) => a.speciesSighted && a.speciesSighted.trim()).length;
  const approvalRate = summary.totalSubmitted ? Math.round((summary.totalApproved / summary.totalSubmitted) * 100) : 0;

  sectionTitle(doc, 'Summary');
  const summaryItems = [
    ['Total collected', `${totalKg.toFixed(1)} kg`],
    ['Activities logged', `${activities.length}`],
    ['Approval rate', `${approvalRate}%`],
    ['Hazard sites logged', `${hazardSites}`],
    ['Species sightings', `${speciesSightings}`],
  ];
  const colWidth = (doc.page.width - doc.page.margins.left - doc.page.margins.right) / summaryItems.length;
  const summaryY = doc.y;
  summaryItems.forEach(([label, value], i) => {
    const x = doc.page.margins.left + i * colWidth;
    doc.fontSize(14).fillColor(PRIMARY).text(value, x, summaryY, { width: colWidth - 8 });
    doc.fontSize(8).fillColor(MUTED).text(label.toUpperCase(), x, summaryY + 18, { width: colWidth - 8 });
  });
  doc.x = doc.page.margins.left;
  doc.y = summaryY + 44;

  if (activities.length === 0) {
    doc.moveDown(0.5);
    doc.fontSize(11).fillColor(MUTED).text('No approved activities were logged in this period.', doc.page.margins.left, doc.y);
  } else {
    sectionTitle(doc, 'Activity Log');
    table(doc, {
      columns: [
        { label: 'Date', width: 62 },
        { label: 'Location', width: 130 },
        { label: 'Category', width: 60 },
        { label: 'Qty (kg)', width: 50 },
        { label: 'Disposal', width: 80 },
        { label: 'Proof tx', width: 105 },
      ],
      rows: activities.map((a) => [
        fmtDate(a.submittedAt),
        a.location || '—',
        a.category || '—',
        a.quantity ?? 0,
        a.disposalMethod || '—',
        shortHash(a.onchainTxHash),
      ]),
    });

    sectionTitle(doc, 'Site Conditions & Hazards');
    const siteCombos = tally(activities, (a) =>
      a.shorelineType || a.tideState ? `${a.shorelineType || 'Unspecified'} · ${a.tideState || 'Unspecified'}` : null
    );
    table(doc, {
      columns: [
        { label: 'Shoreline · Tide state', width: 300 },
        { label: 'Count', width: 60 },
      ],
      rows: siteCombos.length ? siteCombos.map(([key, count]) => [key, count]) : [['No site condition data recorded', '']],
    });

    const hazardCounts = [
      ['Medical hazards', activities.filter((a) => a.hazards.medical).length],
      ['Chemical hazards', activities.filter((a) => a.hazards.chemical).length],
      ['Unstable terrain', activities.filter((a) => a.hazards.unstable).length],
    ];
    table(doc, {
      columns: [
        { label: 'Hazard type', width: 300 },
        { label: 'Sites', width: 60 },
      ],
      rows: hazardCounts.map(([key, count]) => [key, count]),
    });

    sectionTitle(doc, 'Habitat & Species Observations');
    const speciesFreq = tally(activities, (a) => a.speciesSighted?.trim() || null);
    table(doc, {
      columns: [
        { label: 'Species sighted', width: 300 },
        { label: 'Times', width: 60 },
      ],
      rows: speciesFreq.length ? speciesFreq.map(([key, count]) => [key, count]) : [['No species sightings recorded', '']],
    });

    const habitatFreq = tally(activities, (a) => a.habitatStress?.trim() || null);
    table(doc, {
      columns: [
        { label: 'Habitat stress note', width: 300 },
        { label: 'Times', width: 60 },
      ],
      rows: habitatFreq.length ? habitatFreq.map(([key, count]) => [key, count]) : [['No habitat stress notes recorded', '']],
    });
  }

  ensureSpace(doc, 40);
  doc.moveDown(0.6);
  doc.fontSize(8).fillColor(MUTED).text(
    "Every approved activity above is independently timestamped on the Cardano blockchain by BlueMind's backend wallet. "
    + 'To verify an individual entry, fetch GET /api/activities/:id/proof with that activity\'s ID.',
    doc.page.margins.left,
    doc.y
  );

  doc.end();
}
