require('dotenv').config();

if (process.env.NODE_ENV === 'production') {
  require('newrelic');
}

const assert = require('assert');
const cron = require('node-cron');
const { App, LogLevel } = require('@slack/bolt');

const { Admin, Polls, Chores } = require('../core/index');
const { displayThreshold, breakMinDays, achievementWindow } = require('../config');
const { YAY, DAY, CHORES_CONF, SLACKBOT } = require('../constants');
const { getMonthStart, getMonthEnd, shiftDate, getPrevMonthEnd, sleep } = require('../utils');

const common = require('./common');
const views = require('./chores.views');

let choresConf;

// Create the app

const app = new App({
  logLevel: LogLevel.WARN,
  signingSecret: process.env.CHORES_SIGNING_SECRET,
  clientId: process.env.CHORES_CLIENT_ID,
  clientSecret: process.env.CHORES_CLIENT_SECRET,
  stateSecret: process.env.STATE_SECRET,
  customRoutes: [ common.homeEndpoint('Chores') ],
  scopes: [
    'channels:history',
    'channels:join',
    'chat:write',
    'commands',
    'groups:history',
    'users:read',
  ],
  installationStore: {
    storeInstallation: async (installation) => {
      await Admin.addHouse(installation.team.id, installation.team.name);
      await Admin.updateHouseConf(installation.team.id, CHORES_CONF, { oauth: installation });
      console.log(`chores installed @ ${installation.team.id}`);
    },
    fetchInstallation: async (installQuery) => {
      ({ choresConf } = (await Admin.getHouse(installQuery.teamId)));
      return choresConf.oauth;
    },
    deleteInstallation: async (installQuery) => {
      await Admin.updateHouseConf(installQuery.teamId, CHORES_CONF, { oauth: null, channel: null });
      console.log(`chores uninstalled @ ${installQuery.teamId}`);
    },
  },
  installerOptions: { directInstall: true },
});

// Define helper functions

async function postMessage (text, blocks) {
  return common.postMessage(app, choresConf.oauth, choresConf.channel, text, blocks);
}

async function postEphemeral (residentId, text) {
  return common.postEphemeral(app, choresConf.oauth, choresConf.channel, residentId, text);
}

async function houseActive (houseId, now) {
  const windowStart = new Date(now.getTime() - 30 * DAY);
  return Admin.houseActive(houseId, 'ChoreClaim', 'claimedAt', windowStart, now);
}

// Event listeners

app.event('app_uninstalled', async ({ context }) => {
  await common.uninstallApp(app, 'chores', context);
});

app.event('user_change', async ({ payload }) => {
  const now = new Date();
  const { user } = payload;

  if (!(await houseActive(user.team_id, now))) { return; }

  console.log(`chores user_change - ${user.team_id} x ${user.id}`);

  await sleep(0 * 1000);
  await common.syncWorkspaceMember(user.team_id, user, now);
});

// Publish the app home

app.event('app_home_opened', async ({ body, event }) => {
  if (event.tab !== 'home') { return; }

  const { now, houseId, residentId } = common.beginHome('chores', body, event);

  let view;
  if (choresConf.channel) {
    const monthStart = getMonthStart(now);
    const choreStats = await Chores.getChoreStats(residentId, monthStart, now);
    const workingResidentCount = await Chores.getWorkingResidentCount(houseId, now);

    view = views.choresHomeView(choreStats, workingResidentCount);
  } else {
    view = views.choresIntroView();
  }

  await common.publishHome(app, choresConf.oauth, residentId, view);

  // This bookkeeping is done after returning the view

  // Resolve any claims
  for (const resolvedClaim of (await Chores.resolveChoreClaims(houseId, now))) {
    console.log(`resolved choreClaim ${resolvedClaim.id}`);
    await common.updateVoteResults(app, choresConf.oauth, resolvedClaim.pollId, now);
  }

  // Resolve any proposals
  for (const resolvedProposal of (await Chores.resolveChoreProposals(houseId, now))) {
    console.log(`resolved choreProposal ${resolvedProposal.id}`);
    await common.updateVoteResults(app, choresConf.oauth, resolvedProposal.pollId, now);
  }

  // Handle monthly bookkeeping
  const chorePenalties = await Chores.addChorePenalties(houseId, now);
  if (chorePenalties.length) {
    // Post penalties, if any
    for (const penaltyHeart of chorePenalties) {
      if (penaltyHeart.value < 0) {
        const text = 'You missed too many chores last month, ' +
          `and lost *${penaltyHeart.value.toFixed(1)}* hearts...`;
        await postEphemeral(penaltyHeart.residentId, text);
      } else if (penaltyHeart.value > 0) {
        const text = 'You did all your chores last month, ' +
          `and earned *${penaltyHeart.value.toFixed(1)}* hearts!`;
        await postEphemeral(penaltyHeart.residentId, text);
      }
    }

    // Post house stats
    const prevMonthEnd = getPrevMonthEnd(now);
    const prevMonthStart = getMonthStart(prevMonthEnd);
    const choreStats = await Chores.getHouseChoreStats(houseId, prevMonthStart, prevMonthEnd);
    if (choreStats.length) {
      const text = ':scroll: *Last month\'s chore points* :scroll: \n' +
        choreStats.map(cs => `\n${views.formatStats(cs)}`)
          .join('');
      await postMessage(text);
    }
  }
});

// Slash commands

app.command('/chores-sync', async ({ ack, command }) => {
  const commandName = '/chores-sync';
  const { now, houseId } = common.beginCommand(commandName, command);

  const text = await common.syncWorkspaceMembers(app, choresConf.oauth, houseId, now);
  await common.replyEphemeral(app, choresConf.oauth, command, text);

  await ack();
});

app.command('/chores-channel', async ({ ack, command }) => {
  const commandName = '/chores-channel';
  const { now, houseId } = common.beginCommand(commandName, command);

  await common.setChannel(app, choresConf.oauth, CHORES_CONF, command);
  await common.syncWorkspaceMembers(app, choresConf.oauth, houseId, now);

  await ack();
});

app.command('/chores-stats', async ({ ack, command }) => {
  const commandName = '/chores-stats';
  const { now, houseId, residentId } = common.beginCommand(commandName, command);

  const monthStart = getMonthStart(now);
  const prevMonthEnd = getPrevMonthEnd(now);
  const prevMonthStart = getMonthStart(prevMonthEnd);

  // TODO: Calculate remaining points in the month

  const choreClaims = await Chores.getChoreClaims(residentId, monthStart, now);
  const choreBreaks = await Chores.getChoreBreaks(houseId, now);
  const choreStats = await Chores.getHouseChoreStats(houseId, prevMonthStart, prevMonthEnd);

  const view = views.choresStatsView(choreClaims, choreBreaks, choreStats);
  await common.openView(app, choresConf.oauth, command.trigger_id, view);

  await ack();
});

app.command('/chores-activate', async ({ ack, command }) => {
  const commandName = '/chores-activate';
  const { now, houseId } = common.beginCommand(commandName, command);

  if (!(await common.isAdmin(app, choresConf.oauth, command.user_id))) {
    await common.replyAdminOnly(app, choresConf.oauth, command);
    return;
  }

  const residents = await Admin.getResidents(houseId, now);

  const view = views.choresActivateView(residents);
  await common.openView(app, choresConf.oauth, command.trigger_id, view);

  await ack();
});

app.view('chores-activate-callback', async ({ ack, body }) => {
  await ack({ response_action: 'clear' });

  const actionName = 'chores-activate-callback';
  const { now, houseId, residentId } = common.beginAction(actionName, body);

  const activate = common.getInputBlock(body, -3).action.selected_option.value === 'true';
  const selectAll = common.getInputBlock(body, -2).select_all.selected_options.length > 0;

  let residentIds;
  let residentsText;

  if (selectAll) {
    // Exclude bots and deleted users
    residentIds = (await app.client.users.list({ token: choresConf.oauth.bot.token }))
      .members
      .filter(member => !(member.is_bot || member.id === SLACKBOT || member.deleted))
      .map(member => member.id);

    residentsText = `all ${residentIds.length} residents`;
  } else {
    residentIds = common.getInputBlock(body, -1).residents.selected_conversations;

    residentsText = residentIds.map(residentId => `<@${residentId}>`).join(' and ');
  }

  let text;

  if (activate) {
    for (const residentId of residentIds) {
      await Admin.activateResident(houseId, residentId, now);
    }
    text = `Activated ${residentsText || 'nobody'} :fire:`;
  } else {
    for (const residentId of residentIds) {
      await Admin.deactivateResident(houseId, residentId);
    }
    text = `Deactivated ${residentsText || 'nobody'} :ice_cube:`;
  }

  await postEphemeral(residentId, text);
});

app.command('/chores-reset', async ({ ack, command }) => {
  const commandName = '/chores-reset';
  common.beginCommand(commandName, command);

  if (!(await common.isAdmin(app, choresConf.oauth, command.user_id))) {
    await common.replyAdminOnly(app, choresConf.oauth, command);
    return;
  }

  const view = views.choresResetView();
  await common.openView(app, choresConf.oauth, command.trigger_id, view);

  await ack();
});

app.view('chores-reset-callback', async ({ ack, body }) => {
  const actionName = 'chores-reset-callback';
  const { now, houseId, residentId } = common.beginAction(actionName, body);

  await Chores.resetChorePoints(houseId, now);

  await postMessage(`<@${residentId}> just reset all chore points :volcano:`);

  await ack();
});

// Claim flow

app.action('chores-claim', async ({ ack, body }) => {
  const actionName = 'chores-claim';
  const { now, houseId } = common.beginAction(actionName, body);

  const choreValues = await Chores.getUpdatedChoreValues(houseId, now);
  const filteredChoreValues = choreValues.filter(choreValue => choreValue.value >= displayThreshold);

  if (!filteredChoreValues.length) {
    const view = views.choresClaimViewZero();
    await common.openView(app, choresConf.oauth, body.trigger_id, view);
  } else {
    const view = views.choresClaimView(filteredChoreValues);
    await common.openView(app, choresConf.oauth, body.trigger_id, view);
  }

  await ack();
});

app.view('chores-claim-2', async ({ ack, body }) => {
  const actionName = 'chores-claim-2';
  common.beginAction(actionName, body);

  const { choreId, choreValueId } = JSON.parse(common.getInputBlock(body, -1).chore.selected_option.value);

  assert(choreId || choreValueId, 'Missing choreId or choreValueId');

  const chore = (choreId)
    ? await Chores.getChore(choreId)
    : await Chores.getSpecialChoreValue(choreValueId);

  const view = views.choresClaimView2(chore);
  await ack({ response_action: 'push', view });
});

app.view('chores-claim-callback', async ({ ack, body }) => {
  await ack({ response_action: 'clear' });

  const actionName = 'chores-claim-callback';
  const { now, houseId, residentId } = common.beginAction(actionName, body);

  const { chore } = JSON.parse(body.view.private_metadata);

  const monthStart = getMonthStart(now);
  let monthlyPoints = await Chores.getAllChorePoints(residentId, monthStart, now);
  let achivementPoints = 0;

  let name;
  let claim;

  // HACK: Can we do better than conditioning on `name`?
  if (chore.name) {
    // Regular chore
    name = chore.name;

    const achievementStart = new Date(now.getTime() - achievementWindow);
    achivementPoints = await Chores.getChorePoints(residentId, chore.id, achievementStart, now);

    // Perform the regular claim, skipping timeSpent for now
    [ claim ] = await Chores.claimChore(houseId, chore.id, residentId, now, 0);

    achivementPoints = achivementPoints + claim.value;
  } else {
    // Special chore
    name = chore.metadata.name;

    // Perform the special claim, skipping timeSpent for now
    [ claim ] = await Chores.claimSpecialChore(houseId, chore.id, residentId, now, 0);
  }

  monthlyPoints = monthlyPoints + claim.value;

  await Polls.submitVote(claim.pollId, residentId, now, YAY);
  const { minVotes } = await Polls.getPoll(claim.pollId);

  const text = 'Someone just completed a chore';
  const blocks = views.choresClaimCallbackView(claim, name, minVotes, achivementPoints, monthlyPoints);
  const { channel, ts } = await postMessage(text, blocks);
  await Polls.updateMetadata(claim.pollId, { channel, ts });

  // Append the description
  if (chore.metadata && chore.metadata.description) {
    const text = `*Description:*\n${chore.metadata.description}`;
    await common.postReply(app, choresConf.oauth, channel, ts, text);
  }
});

// Ranking flow

app.action('chores-rank', async ({ ack, body }) => {
  const actionName = 'chores-rank';
  const { now, houseId } = common.beginAction(actionName, body);

  const choreRankings = await Chores.getCurrentChoreRankings(houseId, now);

  const view = views.choresRankView(choreRankings);
  await common.openView(app, choresConf.oauth, body.trigger_id, view);

  await ack();
});

app.view('chores-rank-2', async ({ ack, body }) => {
  const actionName = 'chores-rank-2';
  const { now, houseId, residentId } = common.beginAction(actionName, body);

  const action = JSON.parse(common.getInputBlock(body, -3).action.selected_option.value);
  const targetChore = JSON.parse(common.getInputBlock(body, -2).chore.selected_option.value);
  const preference = JSON.parse(common.getInputBlock(body, -1).preference.selected_option.value);

  const actionPreference = (action) ? preference : 1 - preference;

  const orientedCurrentPreferences = (await Chores.getResidentChorePreferences(houseId, residentId))
    .map(pref => Chores.orientChorePreferences(targetChore.id, pref))
    .filter(pref => pref);

  const sourceExclusionSet = Chores.createSourceExclusionSet(orientedCurrentPreferences, actionPreference);
  const choreRankings = (await Chores.getCurrentChoreRankings(houseId, now))
    .filter(ranking => ranking.id !== targetChore.id && !sourceExclusionSet.has(ranking.id));

  const view = (choreRankings.length)
    ? views.choresRankView2(actionPreference, targetChore, choreRankings)
    : views.choresRankViewZero(actionPreference);

  await ack({ response_action: 'push', view });
});

app.view('chores-rank-3', async ({ ack, body }) => {
  const actionName = 'chores-rank-3';
  const { now, houseId, residentId } = common.beginAction(actionName, body);

  const { preference, targetChore } = JSON.parse(body.view.private_metadata);
  const sourceChoreIds = common.getInputBlock(body, -1).chores.selected_options
    .map(option => JSON.parse(option.value).id);

  const newPrefs = sourceChoreIds.map((scId) => {
    const pref = { targetChoreId: targetChore.id, sourceChoreId: scId, preference };
    return { residentId, ...Chores.normalizeChorePreference(pref) };
  });

  // Get the proposed ranking
  const proposedRankings = await Chores.getProposedChoreRankings(houseId, newPrefs, now);
  const targetChoreRanking = proposedRankings.find(ranking => ranking.id === targetChore.id);

  // Forward the preferences through metadata
  const prefsMetadata = JSON.stringify({ targetChore, sourceChoreIds, preference });

  const view = views.choresRankView3(targetChore, targetChoreRanking, prefsMetadata);
  await ack({ response_action: 'push', view });
});

app.view('chores-rank-callback', async ({ ack, body }) => {
  const actionName = 'chores-rank-callback';
  const { now, houseId, residentId } = common.beginAction(actionName, body);

  const { targetChore, sourceChoreIds, preference } = JSON.parse(body.view.private_metadata);

  const newPrefs = sourceChoreIds.map((scId) => {
    const pref = { targetChoreId: targetChore.id, sourceChoreId: scId, preference };
    return { residentId, ...Chores.normalizeChorePreference(pref) };
  });

  // Get the real new ranking
  await Chores.setChorePreferences(houseId, newPrefs);
  const choreRankings = await Chores.getCurrentChoreRankings(houseId, now);
  const targetChoreRanking = choreRankings.find(chore => chore.id === targetChore.id);

  const newPriority = Math.round(targetChoreRanking.ranking * 1000);
  const change = newPriority - targetChore.priority;

  if (change > 0) {
    const text = `Someone *prioritized ${targetChore.name}* by *${change}*, to *${newPriority} ppt* :rocket:`;
    await postMessage(text);
  } else if (change < 0) {
    const text = `Someone *deprioritized ${targetChore.name}* by *${Math.abs(change)}*, to *${newPriority} ppt* :snail:`;
    await postMessage(text);
  }

  await ack({ response_action: 'clear' });
});

// Break flow

app.action('chores-break', async ({ ack, body }) => {
  const actionName = 'chores-break';
  common.beginAction(actionName, body);

  const view = views.choresBreakView(new Date());
  await common.openView(app, choresConf.oauth, body.trigger_id, view);

  await ack();
});

app.view('chores-break-callback', async ({ ack, body }) => {
  const actionName = 'chores-break-callback';
  const { now, houseId, residentId } = common.beginAction(actionName, body);

  // Dates come in yyyy-mm-dd format
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const breakStartUtc = new Date(common.getInputBlock(body, 2).date.selected_date);
  const breakEndUtc = new Date(common.getInputBlock(body, 3).date.selected_date);
  const circumstance = common.getInputBlock(body, 4).circumstance.value;

  // Shift the date to align with the system clock
  // TODO: This might be brittle / hacky
  const breakStart = shiftDate(breakStartUtc, now.getTimezoneOffset());
  const breakEnd = shiftDate(breakEndUtc, now.getTimezoneOffset());
  const breakDays = parseInt((breakEnd - breakStart) / DAY);

  if (breakStart < todayStart || breakDays < breakMinDays) {
    const text = 'Not a valid chore break :slightly_frowning_face:';
    await postEphemeral(residentId, text);
  } else {
    // Record the break
    await Chores.addChoreBreak(houseId, residentId, breakStart, breakEnd, circumstance);
    const text = `<@${residentId}> is taking a *${breakDays}-day* break ` +
        `starting ${breakStart.toDateString()} :beach_with_umbrella:\n` +
        `_${circumstance}_`;
    await postMessage(text);
  }

  await ack();
});

// Gift flow

app.action('chores-gift', async ({ ack, body }) => {
  const actionName = 'chores-gift';
  const { now, residentId } = common.beginAction(actionName, body);

  const monthStart = getMonthStart(now);
  const chorePoints = await Chores.getAllChorePoints(residentId, monthStart, now);

  const view = views.choresGiftView(chorePoints);
  await common.openView(app, choresConf.oauth, body.trigger_id, view);

  await ack();
});

app.view('chores-gift-callback', async ({ ack, body }) => {
  const actionName = 'chores-gift-callback';
  const { now, houseId, residentId } = common.beginAction(actionName, body);

  const currentBalance = Number(body.view.private_metadata);
  const recipientId = common.getInputBlock(body, 2).recipient.selected_user;
  const points = common.getInputBlock(body, 3).points.value;
  const circumstance = common.getInputBlock(body, 4).circumstance.value;

  if (!(await Admin.isActive(recipientId, now))) {
    const text = `<@${recipientId}> is not active and cannot earn points :confused:`;
    await postEphemeral(residentId, text);
  } else if (points > currentBalance) {
    const text = 'You can\'t gift more points than you have! :face_with_monocle:';
    await postEphemeral(residentId, text);
  } else {
    // Make the gift
    await Chores.giftChorePoints(houseId, residentId, recipientId, now, points);

    const text = `<@${residentId}> just gifted <@${recipientId}> *${points} points* :gift:\n` +
      `_${circumstance}_`;
    await postMessage(text);
  }

  await ack();
});

// Edit flow

app.action('chores-propose', async ({ ack, body }) => {
  const actionName = 'chores-propose';
  const { now, houseId, residentId } = common.beginAction(actionName, body);

  const isAdmin = await common.isAdmin(app, choresConf.oauth, residentId);
  const minVotes = await Chores.getChoreProposalMinVotes(houseId, now);

  const view = views.choresProposeView(minVotes, isAdmin);
  await common.openView(app, choresConf.oauth, body.trigger_id, view);

  await ack();
});

app.view('chores-propose-2', async ({ ack, body }) => {
  const actionName = 'chores-propose-2';
  const { houseId } = common.beginAction(actionName, body);

  const force = common.getForceInput(common.getInputBlock(body, -2));
  const change = common.getInputBlock(body, -1).change.selected_option.value;

  let chores, view;
  switch (change) {
    case 'add':
      view = views.choresProposeAddView(force);
      break;
    case 'edit':
      chores = await Chores.getChores(houseId);
      view = views.choresProposeEditView(force, chores);
      break;
    case 'delete':
      chores = await Chores.getChores(houseId);
      view = views.choresProposeDeleteView(force, chores);
      break;
    default:
      console.log('No match found!');
      return;
  }

  await ack({ response_action: 'push', view });
});

app.view('chores-propose-edit', async ({ ack, body }) => {
  const actionName = 'chores-propose-edit';
  common.beginAction(actionName, body);

  const { force } = JSON.parse(body.view.private_metadata);
  const { id: choreId } = JSON.parse(common.getInputBlock(body, -1).chore.selected_option.value);
  const chore = await Chores.getChore(choreId);

  const view = views.choresProposeAddView(force, chore);
  await ack({ response_action: 'push', view });
});

app.view('chores-propose-callback', async ({ ack, body }) => {
  const actionName = 'chores-propose-callback';
  const { now, houseId, residentId } = common.beginAction(actionName, body);

  function parseSubmission (body) {
    name = common.parseTitlecase(common.getInputBlock(body, -2).name.value);
    description = common.getInputBlock(body, -1).description.value;
    return { name, description };
  }

  let choreId, name, description, active;
  const privateMetadata = JSON.parse(body.view.private_metadata);

  switch (privateMetadata.change) {
    case 'add':
      // TODO: if chore exists, return ephemeral and exit
      ({ name, description } = parseSubmission(body));
      [ choreId, active ] = [ null, true ];
      break;
    case 'edit':
      ({ name, description } = parseSubmission(body));
      [ choreId, active ] = [ privateMetadata.chore.id, true ];
      break;
    case 'delete':
      ({ id: choreId, name } = JSON.parse(common.getInputBlock(body, -1).chore.selected_option.value));
      [ description, active ] = [ undefined, false ];
      break;
    default:
      console.log('No match found!');
      return;
  }

  const metadata = { description };

  if (privateMetadata.force) {
    await Chores.executeChoreProposal(houseId, choreId, name, metadata, active);

    const text = 'An admin just edited a chore';
    const blocks = views.choresProposeCallbackViewForce(privateMetadata, residentId, name, description);
    await postMessage(text, blocks);
  } else {
    // Create the chore proposal
    const [ proposal ] = await Chores.createChoreProposal(houseId, residentId, choreId, name, metadata, active, now);
    await Polls.submitVote(proposal.pollId, residentId, now, YAY);

    const { minVotes } = await Polls.getPoll(proposal.pollId);

    const text = 'Someone just proposed a chore edit';
    const blocks = views.choresProposeCallbackView(privateMetadata, proposal, minVotes);
    const { channel, ts } = await postMessage(text, blocks);
    await Polls.updateMetadata(proposal.pollId, { channel, ts });
  }

  await ack({ response_action: 'clear' });
});

// Special chore flow

app.action('chores-special', async ({ ack, body }) => {
  const actionName = 'chores-special';
  const { now, houseId } = common.beginAction(actionName, body);

  const availablePoints = await Chores.getTotalAvailablePoints(houseId, now, getMonthEnd(now));

  let view;
  if (availablePoints > 0) {
    const minVotes = await Chores.getSpecialChoreProposalMinVotes(houseId, 0, now);
    view = views.choresSpecialView(availablePoints, minVotes);
  } else {
    view = views.choresSpecialNoPointsView();
  }

  await common.openView(app, choresConf.oauth, body.trigger_id, view);

  await ack();
});

app.view('chores-special-callback', async ({ ack, body }) => {
  const actionName = 'chores-special-callback';
  const { now, houseId, residentId } = common.beginAction(actionName, body);

  const name = common.parseTitlecase(common.getInputBlock(body, -3).name.value);
  const description = common.getInputBlock(body, -2).description.value;
  const points = common.getInputBlock(body, -1).points.value;

  // Create the special chore proposal
  const [ proposal ] = await Chores.createSpecialChoreProposal(houseId, residentId, name, description, points, now);
  await Polls.submitVote(proposal.pollId, residentId, now, YAY);

  const { minVotes } = await Polls.getPoll(proposal.pollId);

  const text = 'Someone just proposed a special chore';
  const blocks = views.choresSpecialCallbackView(proposal, minVotes);
  const { channel, ts } = await postMessage(text, blocks);
  await Polls.updateMetadata(proposal.pollId, { channel, ts });

  await ack({ response_action: 'clear' });
});

// Voting flow

app.action(/poll-vote/, async ({ ack, body, action }) => {
  const actionName = 'chores poll-vote';
  common.beginAction(actionName, body);

  await common.updateVoteCounts(app, choresConf.oauth, body, action);

  await ack();
});

// Ping flow

async function pingChores () {
  const now = new Date();
  const houses = await Admin.getHouses();

  for (const house of houses) {
    if (await houseActive(house.slackId, now)) {
      const choreValues = await Chores.getUpdatedChoreValues(house.slackId, now);
      const pingableChore = choreValues.find(cv => cv.ping); // Only ping highest-value chore
      if (pingableChore) {
        console.log(`Pinging ${house.slackId}`);
        const { choresConf: config } = await Admin.getHouse(house.slackId);
        const text = `Heads up, *${pingableChore.name}* is worth *${pingableChore.value.toFixed(0)} points* :bangbang:`;
        return common.postMessage(app, config.oauth, config.channel, text);
      }
    }
  }
}

// Run every day at 12:00 UTC
cron.schedule('0 12 * * *', async () => {
  console.log('Pinging chores...');
  await pingChores();
});

// Launch the app

(async () => {
  const port = process.env.CHORES_PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Chores app is running on port ${port} in the ${process.env.NODE_ENV} environment`);
})();

// Fin
