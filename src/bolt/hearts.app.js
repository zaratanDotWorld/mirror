require('dotenv').config();

const { App, LogLevel } = require('@slack/bolt');

const { Admin, Polls, Hearts } = require('../core/index');
const { YAY } = require('../constants');

const common = require('./common');
const views = require('./hearts.views');

let heartsOauth;

// Create the app

const app = new App({
  logLevel: LogLevel.INFO,
  clientId: process.env.HEARTS_CLIENT_ID,
  clientSecret: process.env.HEARTS_CLIENT_SECRET,
  signingSecret: process.env.HEARTS_SIGNING_SECRET,
  stateSecret: process.env.STATE_SECRET,
  customRoutes: [ common.homeEndpoint('Hearts') ],
  scopes: [
    'channels:history', 'channels:join', 'channels:read',
    'chat:write',
    'commands',
    'users:read',
    'reactions:write',
  ],
  installationStore: {
    storeInstallation: async (installation) => {
      return Admin.updateHouse({ slackId: installation.team.id, heartsOauth: installation });
    },
    fetchInstallation: async (installQuery) => {
      ({ heartsOauth } = await Admin.getHouse(installQuery.teamId));
      return heartsOauth;
    },
    deleteInstallation: async (installQuery) => {
      return Admin.updateHouse({ slackId: installQuery.teamId, heartsOauth: null });
    },
  },
  installerOptions: { directInstall: true },
});

// Publish the app home

app.event('app_home_opened', async ({ body, event }) => {
  if (event.tab === 'home') {
    console.log('hearts home');
    const houseId = body.team_id;
    const residentId = event.user;

    const now = new Date();

    await Admin.activateResident(houseId, residentId, now);
    await Hearts.initialiseResident(houseId, residentId, now);

    const hearts = await Hearts.getHearts(residentId, now);
    const view = views.heartsHomeView(hearts.sum || 0);
    await common.publishHome(app, heartsOauth, residentId, view);

    // This bookkeeping is done after returning the view
    const { heartsChannel } = await Admin.getHouse(houseId);

    // Resolve any challanges
    await Hearts.resolveChallenges(houseId, now);
    const challengeHearts = await Hearts.getAgnosticHearts(houseId, now);
    for (const challengeHeart of challengeHearts) {
      const text = `<@${challengeHeart.residentId}> lost a challenge, and *${(-challengeHeart.value).toFixed(0)}* heart(s)...`;
      await common.postMessage(app, heartsOauth, heartsChannel, text);
    }

    // Regenerate the monthly half-heart
    const [ regenHeart ] = await Hearts.regenerateHearts(houseId, residentId, now);
    if (regenHeart !== undefined && regenHeart.value > 0) {
      const text = `You regenerated *${regenHeart.value.toFixed(1)}* heart(s)!`;
      await common.postEphemeral(app, heartsOauth, heartsChannel, residentId, text);
    }

    // Issue karma hearts
    const karmaHearts = await Hearts.generateKarmaHearts(houseId, now);
    if (karmaHearts.length > 0) {
      const { heartsChannel } = await Admin.getHouse(houseId);
      const karmaWinners = karmaHearts.map((heart) => `<@${heart.residentId}>`).join(' and ');
      const text = (karmaWinners.length > 1)
        ? `${karmaWinners} get last month's karma hearts :heart_on_fire:`
        : `${karmaWinners} gets last month's karma heart :heart_on_fire:`;
      await common.postMessage(app, heartsOauth, heartsChannel, text);
    }
  }
});

// Slash commands

app.command('/hearts-sync', async ({ ack, command }) => {
  console.log('/hearts-sync');
  await ack();

  await common.syncWorkspace(app, heartsOauth, command, true, true);
});

app.command('/hearts-channel', async ({ ack, command }) => {
  console.log('/hearts-channel');
  await ack();

  await common.setChannel(app, heartsOauth, 'heartsChannel', command);
});

// Challenge flow

app.action('hearts-challenge', async ({ ack, body }) => {
  console.log('hearts-challenge');
  await ack();

  const houseId = body.team.id;
  const residents = await Admin.getResidents(houseId);
  const view = views.heartsChallengeView(residents.length);
  await common.openView(app, heartsOauth, body.trigger_id, view);
});

app.view('hearts-challenge-callback', async ({ ack, body }) => {
  console.log('hearts-challenge-callback');
  await ack();

  const now = new Date();
  const houseId = body.team.id;
  const residentId = body.user.id;

  const challengeeId = common.getInputBlock(body, 2).challengee.selected_user;
  const numHearts = common.getInputBlock(body, 3).hearts.selected_option.value;
  const circumstance = common.getInputBlock(body, 4).circumstance.value;

  // TODO: Return error to user (not console) if channel is not set
  const { heartsChannel } = await Admin.getHouse(houseId);
  if (heartsChannel === null) { throw new Error('Hearts channel not set!'); }

  const unresolvedChallenges = await Hearts.getUnresolvedChallenges(houseId, challengeeId);
  if (unresolvedChallenges.length) {
    const text = `<@${challengeeId}> is already being challenged!`;
    await common.postEphemeral(app, heartsOauth, heartsChannel, residentId, text);
  } else {
    // Initiate the challenge
    const [ challenge ] = await Hearts.issueChallenge(houseId, residentId, challengeeId, numHearts, now, circumstance);
    await Polls.submitVote(challenge.pollId, residentId, now, YAY);

    const { minVotes } = await Polls.getPoll(challenge.pollId);

    const text = 'Someone just issued a hearts challenge';
    const blocks = views.heartsChallengeCallbackView(challenge, minVotes, circumstance);
    const { channel, ts } = await common.postMessage(app, heartsOauth, heartsChannel, text, blocks);
    await Polls.updateMetadata(challenge.pollId, { channel, ts });
  }
});

// Board flow

app.action('hearts-board', async ({ ack, body }) => {
  console.log('hearts-board');
  await ack();

  const houseId = body.team.id;
  const hearts = await Hearts.getHouseHearts(houseId, new Date());

  const view = views.heartsBoardView(hearts);
  await common.openView(app, heartsOauth, body.trigger_id, view);
});

// Voting flow

app.action(/poll-vote/, async ({ ack, body, action }) => {
  console.log('hearts poll-vote');
  await ack();

  await common.updateVoteCounts(app, heartsOauth, body, action);
});

// Karma flow

app.event('message', async ({ payload }) => {
  const karmaRecipients = Hearts.getKarmaRecipients(payload.text);

  if (karmaRecipients.length > 0) {
    console.log('karma message');
    const houseId = payload.team;
    const giverId = payload.user;

    const now = new Date();
    for (const receiverId of karmaRecipients) {
      await Hearts.giveKarma(houseId, giverId, receiverId, now);
    }

    await common.addReaction(app, heartsOauth, payload, 'sparkles');
  }
});

// Launch the app

(async () => {
  const port = process.env.HEARTS_PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Hearts app is running on port ${port} in the ${process.env.NODE_ENV} environment`);
})();

// Fin
