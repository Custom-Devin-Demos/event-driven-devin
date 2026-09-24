const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.CUSTOMER_5A3AC2B9_SLACK_MEMBER_ID || 'U0BU46F4WCU';
const DEVIN_USER_ID = process.env.DEVIN_USER_ID_5A3AC2B9 || 'user-5e154bb05983499ba384fbeadd3f4478';

const SERVICE = 'customer-5a3ac2b9-previs';
const ROUTE = '/api/5a3ac2b9/previs';

const PROJECTS = {
  onslaught: { id: 'onslaught', title: 'Onslaught', year: 2026, director: 'J. Dorsey', stage: 'prep' },
  'misty-green': { id: 'misty-green', title: 'Misty Green', year: 2026, director: 'R. Lowe', stage: 'prep' },
  'club-kid': { id: 'club-kid', title: 'Club Kid', year: 2026, director: 'S. Halkias', stage: 'post' },
};

// Delivery frame formats used by the previs renderer. Keys are the format ids
// the renderer has historically been called with by the internal previs CLI.
const FRAME_FORMATS = {
  'scope-239': { id: 'scope-239', label: '2.39 Anamorphic', aspect: 2.39, width: 4096, height: 1716, squeeze: 2 },
  'flat-185': { id: 'flat-185', label: '1.85 Flat', aspect: 1.85, width: 3996, height: 2160, squeeze: 1 },
  'academy-137': { id: 'academy-137', label: '1.37 Academy', aspect: 1.37, width: 2966, height: 2160, squeeze: 1 },
};

const LOOKS = {
  'vision3-500t': { id: 'vision3-500t', label: 'Kodak Vision3 500T — halation', grain: 'medium', halation: true, mono: false },
  'vision3-250d': { id: 'vision3-250d', label: 'Kodak Vision3 250D — clean', grain: 'fine', halation: false, mono: false },
  'double-x': { id: 'double-x', label: 'Double-X — black & white', grain: 'coarse', halation: false, mono: true },
};

const COVERAGE_PLAN = [
  { size: 'WS', subject: 'Establishing', movement: 'Static', lensMm: 24 },
  { size: 'MS', subject: 'Two-shot', movement: 'Slow push', lensMm: 40 },
  { size: 'CU', subject: 'Reaction', movement: 'Static', lensMm: 65 },
  { size: 'ECU', subject: 'Detail', movement: 'Rack focus', lensMm: 100 },
  { size: 'OTS', subject: 'Over-the-shoulder', movement: 'Handheld', lensMm: 50 },
  { size: 'INS', subject: 'Insert', movement: 'Static', lensMm: 75 },
  { size: 'MCU', subject: 'Single', movement: 'Dolly left', lensMm: 50 },
  { size: 'WS', subject: 'Exit', movement: 'Static', lensMm: 32 },
];

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the customer 5a3ac2b9 (A24 Labs Previs) failure below. This repository hosts many independent demo verticals, each with its own intentional bug and its own Sentry issues (for example POST /api/banking/transfer, POST /api/nab/payment and POST /api/storefront/checkout throw their own TypeErrors and generate constant background traffic). Ignore every issue that is not from POST /api/5a3ac2b9/previs, do not investigate or modify any other vertical, and do not widen the Sentry or Datadog search beyond this route. The failing surface is the A24 Labs page at app/public/verticals/5a3ac2b9.html (page route GET /5a3ac2b9, aliases /a24 and /a24labs), whose "Generate board" button posts to POST /api/5a3ac2b9/previs in app/routes/verticals/5a3ac2b9.js. The previs pipeline lives in app/services/verticals/5a3ac2b9.js: generateBoard -> resolveFrameFormat, then planCoverage -> frameShot. Start at resolveFrameFormat: the page submits the frame format id "anamorphic-239" (the default option), but FRAME_FORMATS still registers the 2.39 anamorphic delivery under the legacy previs-CLI id "scope-239", so the lookup returns undefined and frameShot dereferences it to compute the framing for each setup. Register the "anamorphic-239" id (keeping "scope-239" working for the CLI) and make an unknown frame format fail as a handled PrevisError (HTTP 400) instead of a TypeError. Do not change the page's look and feel, and do not touch the other verticals' intentional bugs. Verify by starting the server (node app/server.js) and POSTing {"projectId":"onslaught","frameFormat":"anamorphic-239","lookId":"vision3-500t","shotCount":4} to /api/5a3ac2b9/previs, which must return success:true with a 4-shot board, and confirm npm run lint passes.

Reproduce before you diagnose. Your first action after reading the alert, before reading any source file and before proposing a cause, is to start the server (node app/server.js), open /a24?repro=1 in a real browser, scroll to the "Build a shot board." section and click "Generate board" with your screen recording, so the recording shows the page, the click and the failure toast in the bottom-right corner. Always use ?repro=1 for your own clicks: the request fails identically but raises no Sentry event, Slack alert or Devin session, so your reproduction does not alert anyone or spawn another session. Only once you have reproduced the failure yourself do you start investigating. If it does not reproduce, stop and report that instead of fixing anything.

Verification evidence is mandatory and must be visual, not curl-only: after the fix, repeat exactly the same /a24?repro=1 browser click with a second screen recording, showing the rendered shot board and the success banner where the failure toast used to be. Attach both — an animated webp of the reproduction recording under a "Reproduction" heading and an animated webp of the post-fix recording plus a screenshot of the rendered board under a "Fix Verification" heading — to the pull request, and post the same evidence as a comment on the PR. Do not report the fix as complete, and do not leave the PR description saying verification is pending, until both recordings are attached.`;

class PrevisError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.name = 'PrevisError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function resolveProject(projectId) {
  const project = PROJECTS[projectId];
  if (!project) {
    throw new PrevisError(`Unknown project '${projectId}'`, 'UNKNOWN_PROJECT');
  }
  return project;
}

function resolveLook(lookId) {
  const look = LOOKS[lookId];
  if (!look) {
    throw new PrevisError(`Unknown look '${lookId}'`, 'UNKNOWN_LOOK');
  }
  return look;
}

function resolveFrameFormat(frameFormatId) {
  return FRAME_FORMATS[frameFormatId];
}

function parseScene(sceneText) {
  const text = String(sceneText || '').trim();
  if (!text) {
    throw new PrevisError('Scene text is required', 'EMPTY_SCENE');
  }
  const headingMatch = text.match(/^(INT\.|EXT\.|INT\/EXT\.)\s*([^—.-]+)[—-]\s*(DAY|NIGHT|DAWN|DUSK)?\.?/i);
  const heading = headingMatch ? headingMatch[0].replace(/\.$/, '').trim() : 'UNTITLED SCENE';
  const body = headingMatch ? text.slice(headingMatch[0].length).trim() : text;
  const beats = body.split(/(?<=[.!?])\s+/).filter(Boolean);
  return {
    heading,
    location: headingMatch ? headingMatch[2].trim() : 'Unknown',
    timeOfDay: headingMatch && headingMatch[3] ? headingMatch[3].toUpperCase() : 'DAY',
    beats: beats.length ? beats : [heading],
  };
}

function frameShot(setup, index, frame, look, scene) {
  const beat = scene.beats[Math.min(index, scene.beats.length - 1)] || scene.heading;
  const squeezedLens = Math.round(setup.lensMm * frame.squeeze);
  return {
    number: String(index + 1).padStart(2, '0'),
    size: setup.size,
    subject: setup.subject,
    description: beat,
    lens: `${squeezedLens}mm${frame.squeeze > 1 ? ' anamorphic' : ''}`,
    movement: setup.movement,
    framing: { width: frame.width, height: frame.height, aspect: frame.aspect },
    grade: look.mono ? 'B&W' : look.halation ? 'Halation' : 'Clean',
  };
}

function planCoverage(scene, frame, look, shotCount) {
  return COVERAGE_PLAN.slice(0, shotCount).map((setup, index) => frameShot(setup, index, frame, look, scene));
}

async function generateBoard(data) {
  const startTime = Date.now();
  const boardId = `PV-${uuidv4().slice(0, 8).toUpperCase()}`;
  const projectId = data.projectId || 'onslaught';
  const frameFormatId = data.frameFormat || 'anamorphic-239';
  const lookId = data.lookId || 'vision3-500t';
  const shotCount = Math.min(Math.max(Number(data.shotCount) || 4, 1), COVERAGE_PLAN.length);

  const project = resolveProject(projectId);
  const look = resolveLook(lookId);
  const scene = parseScene(data.sceneText);

  logger.info('Generating previs board', {
    boardId,
    projectId,
    frameFormatId,
    lookId,
    shotCount,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 140 + Math.random() * 180));

    const frame = resolveFrameFormat(frameFormatId);
    const shots = planCoverage(scene, frame, look, shotCount);
    const duration = Date.now() - startTime;

    incrementMetric('previs.board_success', {
      route: ROUTE,
      project: projectId,
      frame: frameFormatId,
      shots: String(shots.length),
    });
    recordTiming('previs.render_latency', duration, { route: ROUTE });

    return {
      success: true,
      board: {
        boardId,
        project,
        scene: { heading: scene.heading, location: scene.location, timeOfDay: scene.timeOfDay },
        frame,
        look,
        shots,
        renderMs: duration,
      },
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('previs.board_failure', {
      route: ROUTE,
      project: projectId,
      frame: frameFormatId,
      errorClass: error.name,
    });
    recordTiming('previs.render_latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Previs board generation failed', {
      boardId,
      projectId,
      frameFormatId,
      lookId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    if (data.synthetic) {
      throw error;
    }

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        project: projectId,
        frame: frameFormatId,
        alert_path: 'instant',
      },
      extra: {
        boardId,
        lookId,
        shotCount,
        sceneHeading: scene.heading,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/5a3ac2b9.js — frameShot',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId || DEVIN_USER_ID,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'A24 Labs — Previs',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '5a3ac2b9',
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'project', value: projectId },
        { key: 'frame', value: frameFormatId },
      ],
      extra: {
        boardId,
        lookId,
        shotCount,
        sceneHeading: scene.heading,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for previs error', {
        error: alertError.message,
        boardId,
      });
    });

    throw error;
  }
}

module.exports = {
  generateBoard,
  resolveFrameFormat,
  planCoverage,
  parseScene,
  PrevisError,
  PROJECTS,
  FRAME_FORMATS,
  LOOKS,
};
