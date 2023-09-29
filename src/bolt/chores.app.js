require('dotenv').config();

const { App, LogLevel } = require('@slack/bolt');

const { Admin, Polls, Chores } = require('../core/index');
const { pointsPerResident, displayThreshold } = require('../config');
const { YAY, DAY } = require('../constants');
const { getMonthStart, shiftDate } = require('../utils');

const common = require('./common');
const views = require('./chores.views');

let choresOauth;

// Create the app

const app = new App({
  logLevel: LogLevel.INFO,
  signingSecret: process.env.CHORES_SIGNING_SECRET,
  clientId: process.env.CHORES_CLIENT_ID,
  clientSecret: process.env.CHORES_CLIENT_SECRET,
  stateSecret: process.env.STATE_SECRET,
  customRoutes: [ common.homeEndpoint('Chores') ],
  scopes: [
    'channels:join',
    'chat:write',
    'commands',
    'users:read'
  ],
  installationStore: {
    storeInstallation: async (installation) => {
      return Admin.updateHouse({ slackId: installation.team.id, choresOauth: installation });
    },
    fetchInstallation: async (installQuery) => {
      ({ choresOauth } = await Admin.getHouse(installQuery.teamId));
      return choresOauth;
    },
    deleteInstallation: async (installQuery) => {
      return Admin.updateHouse({ slackId: installQuery.teamId, choresOauth: null });
    }
  },
  installerOptions: { directInstall: true }
});

// Publish the app home

app.event('app_home_opened', async ({ body, event }) => {
  if (event.tab === 'home') {
    console.log('chores home');
    const houseId = body.team_id;
    const residentId = event.user;

    const now = new Date();
    const monthStart = getMonthStart(now);

    await Admin.activateResident(houseId, residentId, now);
    const resident = await Admin.getResident(residentId);

    const chorePoints = await Chores.getAllChorePoints(residentId, monthStart, now);
    const workingPercentage = await Chores.getWorkingResidentPercentage(residentId, now);
    const workingResidents = await Chores.getWorkingResidentCount(houseId, now);

    const pointsOwed = workingPercentage * pointsPerResident;
    const residentExempt = resident.exemptAt && resident.exemptAt <= now;

    const view = views.choresHomeView(chorePoints.sum || 0, pointsOwed, workingResidents, residentExempt);
    await common.publishHome(app, choresOauth, residentId, view);

    // This bookkeeping is done after returning the view

    // Resolve any claims
    await Chores.resolveChoreClaims(houseId, now);

    // Resolve any proposals
    await Chores.resolveChoreProposals(houseId, now);

    // Give monthly penalty if needed
    const [ penaltyHeart ] = await Chores.addChorePenalty(houseId, residentId, now);
    if (penaltyHeart !== undefined && penaltyHeart.value < 0) {
      const { choresChannel } = await Admin.getHouse(houseId);
      const text = `You missed too many chores last month, and lost *${penaltyHeart.value.toFixed(1)}* hearts...`;
      await common.postEphemeral(app, choresOauth, choresChannel, residentId, text); // TODO: make public?
    }
  }
});

// Slash commands

app.command('/chores-sync', async ({ ack, command }) => {
  console.log('/chores-sync');
  await ack();

  await common.syncWorkspace(app, choresOauth, command, true, false);
});

app.command('/chores-channel', async ({ ack, command }) => {
  console.log('/chores-channel');
  await ack();

  await common.setChannel(app, choresOauth, 'choresChannel', command);
});

app.command('/chores-exempt', async ({ ack, command }) => {
  console.log('/chores-exempt');
  await ack();

  const houseId = command.team_id;
  const now = new Date();

  let text;

  if (command.text === 'help' || command.text.length === 0) {
    text = 'Enter "list" to see exempt residents, ' +
    'or "yes" or "no" followed by the residents to exempt (or unexempt).';
  } else if (command.text === 'list') {
    const residents = await Admin.getResidents(houseId);
    text = '*Exempt Residents:*' + residents
      .filter(r => r.exemptAt && r.exemptAt <= now)
      .sort((a, b) => a.exemptAt < b.exemptAt)
      .map(r => `\n${r.exemptAt.toDateString()} - <@${r.slackId}>`)
      .join('');
  } else if (await common.isAdmin(app, choresOauth, command)) {
    const flag = command.text.split(' ')[0];
    const args = command.text.split(' ').slice(1).join(' ');
    const residentIds = common.parseEscapedUsernames(args);

    if (flag === 'yes') {
      text = 'Exempted';
      for (const residentId of residentIds) {
        text += ` <@${residentId}>`;
        await Admin.exemptResident(houseId, residentId, now);
      }
    } else if (flag === 'no') {
      text = 'Unexempted';
      for (const residentId of residentIds) {
        text += ` <@${residentId}>`;
        await Admin.unexemptResident(houseId, residentId);
      }
    } else {
      text = 'Please start command with either "list" "yes" or "no"';
    }
  } else {
    text = ':warning: Only admins can exempt residents...';
  }

  await common.replyEphemeral(app, choresOauth, command, text);
});

// Claim flow

app.action('chores-claim', async ({ ack, body }) => {
  console.log('chores-claim');
  await ack();

  const choreValues = await Chores.getUpdatedChoreValues(body.team.id, new Date(), pointsPerResident);
  const filteredChoreValues = choreValues.filter(choreValue => choreValue.value >= displayThreshold);

  const view = views.choresClaimView(filteredChoreValues);
  await common.openView(app, choresOauth, body.trigger_id, view);
});

app.action('chores-claim-2', async ({ ack, body }) => {
  console.log('chores-claim-2');
  await ack();

  const choreId = body.actions[0].selected_option.value.split('|')[0];
  const chore = await Chores.getChore(choreId);

  const view = views.choresClaimView2(chore);
  await common.pushView(app, choresOauth, body.trigger_id, view);
});

app.view('chores-claim-callback', async ({ ack, body }) => {
  console.log('chores-claim-callback');
  await ack({ response_action: 'clear' });

  const residentId = body.user.id;
  const houseId = body.team.id;

  const [ choreId, choreName ] = body.view.private_metadata.split('|');

  // TODO: Return error to user (not console) if channel is not set
  const { choresChannel } = await Admin.getHouse(houseId);
  if (choresChannel === null) { throw new Error('Chores channel not set!'); }

  // Get chore points over last six months
  const now = new Date();
  const monthStart = getMonthStart(now);
  const sixMonths = new Date(now.getTime() - 180 * DAY);
  let monthlyPoints = await Chores.getAllChorePoints(residentId, monthStart, now);
  let recentPoints = await Chores.getChorePoints(residentId, choreId, sixMonths, now);

  // Perform the claim
  const [ claim ] = await Chores.claimChore(houseId, choreId, residentId, now);
  await Polls.submitVote(claim.pollId, residentId, now, YAY);

  // Update point values
  recentPoints = (recentPoints.sum || 0) + claim.value;
  monthlyPoints = (monthlyPoints.sum || 0) + claim.value;

  const text = 'Someone just completed a chore';
  const blocks = views.choresClaimCallbackView(claim, choreName, recentPoints, monthlyPoints);
  const { channel, ts } = await common.postMessage(app, choresOauth, choresChannel, text, blocks);
  await Polls.updateMetadata(claim.pollId, { channel, ts });

  // Temporarily emit this functionality
  // // Append the description
  // const chore = await Chores.getChore(choreId);
  // if (chore.metadata && chore.metadata.description) {
  //   const text = `*${chore.name}:*\n\n${chore.metadata.description}`;
  //   await common.postReply(app, choresOauth, choresChannel, ts, text);
  // }
});

// Ranking flow

app.action('chores-rank', async ({ ack, body }) => {
  console.log('chores-rank');
  await ack();

  const view = views.choresRankView();
  await common.openView(app, choresOauth, body.trigger_id, view);
});

app.action('chores-rank-2', async ({ ack, body }) => {
  console.log('chores-rank-2');
  await ack();

  const direction = body.actions[0].selected_option.value;
  const choreRankings = await Chores.getCurrentChoreRankings(body.team.id);

  const view = views.choresRankView2(direction, choreRankings);
  await common.pushView(app, choresOauth, body.trigger_id, view);
});

app.view('chores-rank-callback', async ({ ack, body }) => {
  console.log('chores-rank-callback');
  await ack({ response_action: 'clear' });

  const residentId = body.user.id;
  const houseId = body.team.id;

  const FASTER = 'faster';
  const SLOWER = 'slower';

  const direction = body.view.private_metadata;
  const target = common.getInputBlock(body, 3).chores.selected_option.value;
  const sources = common.getInputBlock(body, 4).chores.selected_options;
  const [ targetChoreId, targetChoreName, targetChoreSpeed ] = target.split('|');

  let alphaChoreId;
  let betaChoreId;
  let preference;

  for (const source of sources) {
    const sourceChoreId = source.value.split('|')[0];
    if (sourceChoreId === targetChoreId) { continue; }

    // Value flows from source to target, and from beta to alpha
    if (parseInt(targetChoreId) < parseInt(sourceChoreId)) {
      alphaChoreId = parseInt(targetChoreId);
      betaChoreId = parseInt(sourceChoreId);
      preference = Number(direction === FASTER);
    } else {
      alphaChoreId = parseInt(sourceChoreId);
      betaChoreId = parseInt(targetChoreId);
      preference = Number(direction === SLOWER);
    }

    // Perform the update
    await Chores.setChorePreference(houseId, residentId, alphaChoreId, betaChoreId, preference);
    console.log(`Chore preference updated, ${alphaChoreId} vs ${betaChoreId} at ${preference}`);
  }

  const choreRankings = await Chores.getCurrentChoreRankings(houseId);
  const targetChoreRanking = choreRankings.find((chore) => chore.id === parseInt(targetChoreId));

  const bigChange = (1000 / choreRankings.length) / 5; // 20% of the average speed
  const ppt = (targetChoreRanking.ranking * 1000).toFixed(0);
  const speedDiff = ppt - parseInt(targetChoreSpeed);
  const speedText = (Math.abs(speedDiff) > bigChange) ? 'a lot' : 'a little';

  const { choresChannel } = await Admin.getHouse(houseId);
  if (speedDiff > 0) {
    const text = `Someone sped up *${targetChoreName}* by *${speedText}*, to *${ppt} ppt* :rocket:`;
    await common.postMessage(app, choresOauth, choresChannel, text);
  } else if (speedDiff < 0) {
    const { choresChannel } = await Admin.getHouse(houseId);
    const text = `Someone slowed down *${targetChoreName}* by *${speedText}*, to *${ppt} ppt* :snail:`;
    await common.postMessage(app, choresOauth, choresChannel, text);
  } else {
    const text = 'You\'ve already input those preferences. ' +
      'To have an additional effect, *choose more or different chores*. ' +
      'Alternatively, *convince others* to support your priorities.';
    await common.postEphemeral(app, choresOauth, choresChannel, residentId, text);
  }
});

// Break flow

app.action('chores-break', async ({ ack, body }) => {
  console.log('chores-break');
  await ack();

  const view = views.choresBreakView(new Date());
  await common.openView(app, choresOauth, body.trigger_id, view);
});

app.view('chores-break-callback', async ({ ack, body }) => {
  console.log('chores-break-callback');
  await ack();

  const residentId = body.user.id;
  const houseId = body.team.id;

  // Dates come in yyyy-mm-dd format
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const breakStartUtc = new Date(common.getInputBlock(body, 2).date.selected_date);
  const breakEndUtc = new Date(common.getInputBlock(body, 3).date.selected_date);
  const circumstance = common.getInputBlock(body, 4).circumstance.value;

  // Shift the date to align with the system clock
  // TODO: This might be brittle / hacky
  const breakStart = shiftDate(breakStartUtc, now.getTimezoneOffset());
  const breakEnd = shiftDate(breakEndUtc, now.getTimezoneOffset());
  const breakDays = parseInt((breakEnd - breakStart) / DAY);

  const { choresChannel } = await Admin.getHouse(houseId);
  if (breakStart < todayStart || breakDays < 3) {
    const text = 'Not a valid chore break :slightly_frowning_face:';
    await common.postEphemeral(app, choresOauth, choresChannel, residentId, text);
  } else {
    // Record the break
    await Chores.addChoreBreak(houseId, residentId, breakStart, breakEnd, circumstance);
    const text = `<@${residentId}> is taking a *${breakDays}-day* break ` +
        `starting ${breakStart.toDateString()} :beach_with_umbrella:\n` +
        `_${circumstance}_`;
    await common.postMessage(app, choresOauth, choresChannel, text);
  }
});

// Gift flow

app.action('chores-gift', async ({ ack, body }) => {
  console.log('chores-gift');
  await ack();

  const residentId = body.user.id;
  const now = new Date();
  const monthStart = getMonthStart(now);
  const chorePoints = await Chores.getAllChorePoints(residentId, monthStart, now);

  const view = views.choresGiftView(chorePoints.sum || 0);
  await common.openView(app, choresOauth, body.trigger_id, view);
});

app.view('chores-gift-callback', async ({ ack, body }) => {
  console.log('chores-gift-callback');
  await ack();

  const residentId = body.user.id;
  const houseId = body.team.id;

  const recipientId = common.getInputBlock(body, 2).recipient.selected_user;
  const value = Number(common.getInputBlock(body, 3).value.value);
  const circumstance = common.getInputBlock(body, 4).circumstance.value;
  const pointsBalance = Number(body.view.private_metadata);

  const { choresChannel } = await Admin.getHouse(houseId);
  if (value <= pointsBalance) {
    // Make the gift
    await Chores.giftChorePoints(houseId, residentId, recipientId, new Date(), value);

    const text = `<@${residentId}> just gifted <@${recipientId}> *${value} points* :gift:\n` +
      `_${circumstance}_`;
    await common.postMessage(app, choresOauth, choresChannel, text);
  } else {
    const text = 'You can\'t gift more points than you have! :face_with_monocle:';
    await common.postEphemeral(app, choresOauth, choresChannel, residentId, text);
  }
});

// Edit flow

app.action('chores-propose', async ({ ack, body }) => {
  console.log('chores-propose');
  await ack();

  const houseId = body.team.id;
  const minVotes = await Chores.getChoreProposalMinVotes(houseId);

  const view = views.choresProposeView(minVotes);
  await common.openView(app, choresOauth, body.trigger_id, view);
});

app.action('chores-propose-2', async ({ ack, body }) => {
  console.log('chores-propose-2');
  await ack();

  const houseId = body.team.id;
  const change = body.actions[0].selected_option.value;

  let chores, view;
  switch (change) {
    case 'add':
      view = views.choresProposeAddView();
      break;
    case 'edit':
      chores = await Chores.getChores(houseId);
      view = views.choresProposeEditView(chores);
      break;
    case 'delete':
      chores = await Chores.getChores(houseId);
      view = views.choresProposeDeleteView(chores);
      break;
    default:
      console.log('No match found!');
      return;
  }

  await common.pushView(app, choresOauth, body.trigger_id, view);
});

app.action('chores-propose-edit', async ({ ack, body }) => {
  console.log('chores-propose-edit');
  await ack();

  const { id: choreId } = JSON.parse(body.actions[0].selected_option.value);
  const chore = await Chores.getChore(choreId);

  const blocks = views.choresProposeEditView2(chore);
  await common.pushView(app, choresOauth, body.trigger_id, blocks);
});

app.view('chores-propose-callback', async ({ ack, body }) => {
  console.log('chores-propose-callback');
  await ack({ response_action: 'clear' });

  const residentId = body.user.id;
  const houseId = body.team.id;
  const now = new Date();

  let choreId, name, description, active;
  const metadata = JSON.parse(body.view.private_metadata);

  switch (metadata.type) {
    case 'add':
      // TODO: if chore exists, return ephemeral and exit
      name = views.formatChoreName(common.getInputBlock(body, -2).name.value);
      description = common.getInputBlock(body, -1).description.value;
      [ choreId, active ] = [ null, true ];
      break;
    case 'edit':
      name = views.formatChoreName(common.getInputBlock(body, -2).name.value);
      description = common.getInputBlock(body, -1).description.value;
      [ choreId, active ] = [ metadata.chore.id, true ];
      break;
    case 'delete':
      ({ id: choreId, name } = JSON.parse(common.getInputBlock(body, -1).chores.selected_option.value));
      [ description, active ] = [ undefined, false ];
      break;
    default:
      console.log('No match found!');
      return;
  }

  // Create the chore proposal
  const [ proposal ] = await Chores.createChoreProposal(houseId, residentId, choreId, name, { description }, active, now);
  await Polls.submitVote(proposal.pollId, residentId, now, YAY);

  const { choresChannel } = await Admin.getHouse(houseId);
  const minVotes = await Chores.getChoreProposalMinVotes(houseId);

  const text = 'Someone just proposed a chore edit';
  const blocks = views.choresProposeCallbackView(metadata, proposal, residentId, minVotes);
  const { channel, ts } = await common.postMessage(app, choresOauth, choresChannel, text, blocks);
  await Polls.updateMetadata(proposal.pollId, { channel, ts });
});

// Voting flow

app.action(/poll-vote/, async ({ ack, body, action }) => {
  console.log('chores poll-vote');
  await ack();

  await common.updateVoteCounts(app, choresOauth, body, action);
});

// Launch the app

(async () => {
  const port = process.env.CHORES_PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Chores app is running on port ${port} in the ${process.env.NODE_ENV} environment`);
})();

// Fin
