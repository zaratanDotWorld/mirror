require('dotenv').config();

const { App, LogLevel } = require('@slack/bolt');

const Chores = require('../modules/chores');
const Polls = require('../modules/polls');
const Admin = require('../modules/admin');

const { choresPollLength, pointsPerResident, displayThreshold } = require('../config');
const { YAY, DAY } = require('../constants');
const { sleep, getMonthStart } = require('../utils');

const blocks = require('./blocks');

let res;
let choresOauth;

// Create the app

const home = {
  path: '/',
  method: [ 'GET' ],
  handler: async (_, res) => {
    res.writeHead(200);
    res.end('Welcome to Mirror - Chores!');
  }
};

const app = new App({
  logLevel: LogLevel.INFO,
  signingSecret: process.env.CHORES_SIGNING_SECRET,
  clientId: process.env.CHORES_CLIENT_ID,
  clientSecret: process.env.CHORES_CLIENT_SECRET,
  stateSecret: process.env.STATE_SECRET,
  customRoutes: [ home ],
  scopes: [
    'channels:history', 'channels:read',
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
    const houseId = body.team_id;
    const residentId = event.user;

    await Admin.addResident(houseId, residentId);
    console.log(`Added resident ${residentId}`);

    const now = new Date();
    const monthStart = getMonthStart(now);
    const userChorePoints = await Chores.getAllChorePoints(residentId, monthStart, now);
    const userActivePercentage = await Chores.getActiveResidentPercentage(residentId, now);

    const data = {
      token: choresOauth.bot.token,
      user_id: residentId,
      view: blocks.choresHomeView(userChorePoints.sum || 0, userActivePercentage * pointsPerResident)
    };
    await app.client.views.publish(data);

    // This bookkeeping is done asynchronously
    // TODO: resolve chore claims
    await Chores.addChorePenalty(houseId, residentId, now);
  }
});

// Slash commands

async function getUser (userId) {
  return app.client.users.info({
    token: choresOauth.bot.token,
    user: userId
  });
}

function prepareEphemeral (command, text) {
  return {
    token: choresOauth.bot.token,
    channel: command.channel_id,
    user: command.user_id,
    text: text
  };
}

app.command('/chores-channel', async ({ ack, command, say }) => {
  await ack();

  const channelName = command.text;
  const houseId = command.team_id;
  const userInfo = await getUser(command.user_id);

  let text;

  if (userInfo.user.is_admin) {
    // TODO: return a friendly error if the channel doesn't exist
    res = await app.client.conversations.list({ token: choresOauth.bot.token });
    const channelId = res.channels.filter(channel => channel.name === channelName)[0].id;

    await Admin.updateHouse({ slackId: houseId, choresChannel: channelId });

    text = `Chore claims channel set to ${channelName} :fire:\nPlease add the Chores bot to the channel`;
    console.log(`Set chore claims channel to ${channelName}`);
  } else {
    text = 'Only admins can set the channels...';
  }

  const message = prepareEphemeral(command, text);
  await app.client.chat.postEphemeral(message);
});

app.command('/chores-add', async ({ ack, command, say }) => {
  await ack();

  const userInfo = await getUser(command.user_id);

  let text;

  if (userInfo.user.is_admin) {
    const choreName = blocks.formatChoreName(command.text);
    await Chores.addChore(command.team_id, choreName);

    text = `${choreName} added to the chores list :star-struck:`;
    console.log(`Added chore ${choreName}`);
  } else {
    text = 'Only admins can update the chore list...';
  }

  const message = prepareEphemeral(command, text);
  await app.client.chat.postEphemeral(message);
});

app.command('/chores-del', async ({ ack, command, say }) => {
  await ack();

  const userInfo = await getUser(command.user_id);

  let text;

  if (userInfo.user.is_admin) {
    const choreName = blocks.formatChoreName(command.text);
    await Chores.deleteChore(command.team_id, choreName);

    text = `${choreName} removed from the chores list :sob:`;
    console.log(`Deleted chore ${choreName}`);
  } else {
    text = 'Only admins can update the chore list...';
  }

  const message = prepareEphemeral(command, text);
  await app.client.chat.postEphemeral(message);
});

app.command('/chores-list', async ({ ack, command, say }) => {
  await ack();

  const choresRankings = await Chores.getCurrentChoreRankings(command.team_id);
  const parsedChores = choresRankings.map((chore) => `\n${chore.name} (${chore.ranking.toFixed(2)})`);

  const text = `The current chores and their priority (adding up to 1):${parsedChores}`;
  const message = prepareEphemeral(command, text);
  await app.client.chat.postEphemeral(message);
});

app.command('/chores-sync', async ({ ack, command, say }) => {
  await ack();

  const SLACKBOT = 'USLACKBOT';

  const workspaceMembers = await app.client.users.list({ token: choresOauth.bot.token });

  for (const member of workspaceMembers.members) {
    if (!member.is_bot & member.id !== SLACKBOT) {
      await Admin.updateResident(member.team_id, member.id, !member.deleted, member.real_name);
    }
  }

  const residents = await Admin.getResidents(workspaceMembers.members[0].team_id);

  const text = `Synced workspace, ${residents.length} active residents found`;
  const message = prepareEphemeral(command, text);
  await app.client.chat.postEphemeral(message);
});

// Claim flow

app.action('chores-claim', async ({ ack, body, action }) => {
  await ack();

  const choreValues = await Chores.getUpdatedChoreValues(body.team.id, new Date(), pointsPerResident);
  const filteredChoreValues = choreValues.filter(choreValue => choreValue.value >= displayThreshold);

  const view = {
    token: choresOauth.bot.token,
    trigger_id: body.trigger_id,
    view: blocks.choresClaimView(filteredChoreValues)
  };

  res = await app.client.views.open(view);
  console.log(`Chores-claim opened with id ${res.view.id}`);
});

app.view('chores-claim-callback', async ({ ack, body }) => {
  await ack();

  const residentId = body.user.id;
  const houseId = body.team.id;

  // // https://api.slack.com/reference/interaction-payloads/views#view_submission_fields
  const blockIndex = body.view.blocks.length - 1;
  const blockId = body.view.blocks[blockIndex].block_id;
  const [ choreId, choreName, choreValue ] = body.view.state.values[blockId].options.selected_option.value.split('|');

  const { choresChannel } = await Admin.getHouse(houseId);

  // TODO: Return error to user (not console) if channel is not set
  if (choresChannel === null) { throw new Error('Chores channel not set!'); }

  // Get chore points over last six months
  const now = new Date();
  const sixMonths = new Date(now.getTime() - 180 * DAY);
  const recentPoints = await Chores.getChorePoints(residentId, choreId, sixMonths, now);

  // Perform the claim
  const [ claim ] = await Chores.claimChore(choreId, residentId, now, choresPollLength);
  await Polls.submitVote(claim.pollId, residentId, now, YAY);

  const message = {
    token: choresOauth.bot.token,
    channel: choresChannel,
    text: 'Someone just completed a chore',
    blocks: blocks.choresClaimCallbackView(
      residentId,
      choreName,
      Number(choreValue),
      (recentPoints.sum || 0) + Number(choreValue),
      claim.pollId,
      choresPollLength
    )
  };

  res = await app.client.chat.postMessage(message);
  console.log(`Claim ${claim.id} created with poll ${claim.pollId}`);
});

// Ranking flow

app.action('chores-rank', async ({ ack, body, action }) => {
  await ack();

  const chores = await Chores.getChores(body.team.id);

  const view = {
    token: choresOauth.bot.token,
    trigger_id: body.trigger_id,
    view: blocks.choresRankView(chores)
  };

  res = await app.client.views.open(view);
  console.log(`Chores-rank opened with id ${res.view.id}`);
});

app.view('chores-rank-callback', async ({ ack, body }) => {
  await ack();

  const residentId = body.user.id;
  const houseId = body.team.id;

  // https://api.slack.com/reference/interaction-payloads/views#view_submission_fields

  const targetBlockId = body.view.blocks[2].block_id;
  const sourceBlockId = body.view.blocks[3].block_id;
  const valueBlockId = body.view.blocks[4].block_id;

  const [ targetChoreId, targetChoreName ] = body.view.state.values[targetBlockId].chores.selected_option.value.split('|');
  const [ sourceChoreId, sourceChoreName ] = body.view.state.values[sourceBlockId].chores.selected_option.value.split('|');
  const strength = body.view.state.values[valueBlockId].strength.selected_option.value;

  let alphaChoreId;
  let betaChoreId;
  let preference;

  // TODO: Return a friendly error if you try to prefer a chore to itself

  // Value flows from source to target, and from beta to alpha
  if (parseInt(targetChoreId) < parseInt(sourceChoreId)) {
    alphaChoreId = parseInt(targetChoreId);
    betaChoreId = parseInt(sourceChoreId);
    preference = Number(strength);
  } else {
    alphaChoreId = parseInt(sourceChoreId);
    betaChoreId = parseInt(targetChoreId);
    preference = 1.0 - Number(strength);
  }

  const { choresChannel } = await Admin.getHouse(houseId);

  // Perform the update
  await Chores.setChorePreference(houseId, residentId, alphaChoreId, betaChoreId, preference);

  const message = {
    token: choresOauth.bot.token,
    channel: choresChannel,
    text: `Someone just prioritized ${targetChoreName} over ${sourceChoreName} :rocket:`
  };

  res = await app.client.chat.postMessage(message);
  console.log(`Chore preference updated, ${alphaChoreId} vs ${betaChoreId} at ${preference}`);
});

// Gift flow

app.action('chores-gift', async ({ ack, body, action }) => {
  await ack();

  const residentId = body.user.id;
  const lastChoreclaim = await Chores.getLatestChoreClaim(residentId);

  const view = {
    token: choresOauth.bot.token,
    trigger_id: body.trigger_id,
    view: blocks.choresGiftView(lastChoreclaim.value)
  };

  res = await app.client.views.open(view);
  console.log(`Chores-gift opened with id ${res.view.id}`);
});

app.view('chores-gift-callback', async ({ ack, body }) => {
  await ack();

  const residentId = body.user.id;
  const houseId = body.team.id;

  // https://api.slack.com/reference/interaction-payloads/views#view_submission_fields

  const recipientBlockId = body.view.blocks[2].block_id;
  const valueBlockId = body.view.blocks[3].block_id;

  const recipientId = body.view.state.values[recipientBlockId].recipient.selected_users[0];
  const value = body.view.state.values[valueBlockId].value.value;

  const { choresChannel } = await Admin.getHouse(houseId);

  // Perform the update
  await Chores.giftChorePoints(residentId, recipientId, new Date(), Number(value));

  const message = {
    token: choresOauth.bot.token,
    channel: choresChannel,
    text: `<@${residentId}> just gifted <@${recipientId}> *${value} points* :sparkling_heart:`
  };

  res = await app.client.chat.postMessage(message);
  console.log('Chore points gifted');
});

// Voting flow

app.action(/poll-vote/, async ({ ack, body, action }) => {
  await ack();

  // // Submit the vote
  const [ pollId, value ] = action.value.split('|');
  await Polls.submitVote(pollId, body.user.id, new Date(), value);
  await sleep(5);

  const { yays, nays } = await Polls.getPollResultCounts(pollId);

  // Update the vote counts
  const blockIndex = body.message.blocks.length - 1;
  body.message.token = choresOauth.bot.token;
  body.message.channel = body.channel.id;
  body.message.blocks[blockIndex].elements = blocks.makeVoteButtons(pollId, yays, nays);

  await app.client.chat.update(body.message);

  console.log(`Poll ${pollId} updated`);
});

// Launch the app

(async () => {
  const port = process.env.CHORES_PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Chores app is running on port ${port} in the ${process.env.NODE_ENV} environment`);
})();

// Fin