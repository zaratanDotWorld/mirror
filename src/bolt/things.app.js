require('dotenv').config();

if (process.env.NODE_ENV === 'production') {
  require('newrelic');
}

const { App, LogLevel } = require('@slack/bolt');

const { Admin, Polls, Things } = require('../core/index');
const { YAY, DAY, THINGS_CONF, THINGS_IDX } = require('../constants');
const { sleep } = require('../utils');

const common = require('./common');
const views = require('./things.views');

let thingsConf;

// Create the app

const app = new App({
  logLevel: LogLevel.WARN,
  clientId: process.env.THINGS_CLIENT_ID,
  clientSecret: process.env.THINGS_CLIENT_SECRET,
  signingSecret: process.env.THINGS_SIGNING_SECRET,
  stateSecret: process.env.STATE_SECRET,
  customRoutes: [ common.homeEndpoint('Things') ],
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
      await Admin.updateHouseConf(installation.team.id, THINGS_CONF, { oauth: installation });
      console.log(`things installed @ ${installation.team.id}`);
    },
    fetchInstallation: async (installQuery) => {
      ({ thingsConf } = (await Admin.getHouse(installQuery.teamId)));
      return thingsConf;
    },
    deleteInstallation: async (installQuery) => {
      await Admin.updateHouseConf(installQuery.teamId, THINGS_CONF, { oauth: null, channel: null });
      console.log(`things uninstalled @ ${installQuery.teamId}`);
    },
  },
  installerOptions: { directInstall: true },
});

// Define helper functions

async function postMessage (text, blocks) {
  return common.postMessage(app, thingsConf.oauth, thingsConf.channel, text, blocks);
}

async function postEphemeral (residentId, text) {
  return common.postEphemeral(app, thingsConf.oauth, thingsConf.channel, residentId, text);
}

async function replyEphemeral (command, text) {
  return common.replyEphemeral(app, thingsConf.oauth, command, text);
}

async function houseActive (houseId, now) {
  const windowStart = new Date(now.getTime() - 30 * DAY);
  return Admin.houseActive(houseId, 'ThingBuy', 'boughtAt', windowStart, now);
}

// Event listeners

app.event('app_uninstalled', async ({ context }) => {
  await common.uninstallApp(app, 'things', context);
});

app.event('user_change', async ({ payload }) => {
  const now = new Date();
  const { user } = payload;

  if (!(await houseActive(user.team_id, now))) { return; }

  console.log(`things user_change - ${user.team_id} x ${user.id}`);

  await sleep(THINGS_IDX * 1000);
  await common.pruneWorkspaceMember(user.team_id, user);
});

// Publish the app home

app.event('app_home_opened', async ({ body, event }) => {
  if (event.tab !== 'home') { return; }

  const { now, houseId, residentId } = common.beginHome('things', body, event);

  let view;
  if (thingsConf.channel) {
    const isActive = await Admin.isActive(residentId, now);
    const activeAccounts = await Things.getActiveAccounts(houseId, now);

    view = views.thingsHomeView(isActive, activeAccounts);
  } else {
    view = views.thingsIntroView();
  }

  await common.publishHome(app, thingsConf.oauth, residentId, view);

  // This bookkeeping is done after returning the view

  // Resolve any buys
  for (const resolvedBuy of (await Things.resolveThingBuys(houseId, now))) {
    console.log(`resolved thingBuy ${resolvedBuy.id}`);
    await common.updateVoteResults(app, thingsConf.oauth, resolvedBuy.pollId, now);
  }

  // Resolve any proposals
  for (const resolvedProposal of (await Things.resolveThingProposals(houseId, now))) {
    console.log(`resolved thingProposal ${resolvedProposal.id}`);
    await common.updateVoteResults(app, thingsConf.oauth, resolvedProposal.pollId, now);
  }
});

// Slash commands

app.command('/things-channel', async ({ ack, command }) => {
  const commandName = '/things-channel';
  common.beginCommand(commandName, command);

  await common.setChannel(app, thingsConf.oauth, THINGS_CONF, command);

  await ack();
});

app.command('/things-load', async ({ ack, command }) => {
  const commandName = '/things-load';
  common.beginCommand(commandName, command);

  if (!(await common.isAdmin(app, thingsConf.oauth, command.user_id))) {
    await common.replyAdminOnly(app, thingsConf.oauth, command);
    return;
  }

  const view = views.thingsLoadView();
  await common.openView(app, thingsConf.oauth, command.trigger_id, view);

  await ack();
});

app.view('things-load-2', async ({ ack, body }) => {
  const actionName = 'things-load-2';
  const { now, houseId } = common.beginAction(actionName, body);

  const account = common.parseTitlecase(common.getInputBlock(body, -2).account.value);
  const amount = Number(common.getInputBlock(body, -1).amount.value);

  const currentAmount = await Things.getAccountBalance(houseId, account, now);

  const view = views.thingsLoadView2(account, currentAmount.sum || 0, amount);
  await ack({ response_action: 'push', view });
});

app.view('things-load-callback', async ({ ack, body }) => {
  const actionName = 'things-load-callback';
  const { now, houseId, residentId } = common.beginAction(actionName, body);

  const { account, amount } = JSON.parse(body.view.private_metadata);

  const [ thing ] = await Things.loadAccount(houseId, account, residentId, now, amount);

  const text = `<@${thing.boughtBy}> just loaded *$${thing.value}* into the *${thing.account}* account :chart_with_upwards_trend:`;
  await postMessage(text);

  await ack({ response_action: 'clear' });
});

app.command('/things-fulfill', async ({ ack, command }) => {
  const commandName = '/things-fulfill';
  const { now, houseId } = common.beginCommand(commandName, command);

  if (!(await common.isAdmin(app, thingsConf.oauth, command.user_id))) {
    await common.replyAdminOnly(app, thingsConf.oauth, command);
    return;
  }

  const unfulfilledBuys = await Things.getUnfulfilledThingBuys(houseId, now);

  if (unfulfilledBuys.length) {
    const view = views.thingsFulfillView(unfulfilledBuys);
    await common.openView(app, thingsConf.oauth, command.trigger_id, view);
  } else {
    await replyEphemeral(command, 'There are no buys to fulfill :relieved:');
  }

  await ack();
});

app.view('things-fulfill-callback', async ({ ack, body }) => {
  const actionName = 'things-fulfill-callback';
  const { now, residentId } = common.beginAction(actionName, body);

  const buys = common.getInputBlock(body, -1).buys.selected_options
    .map(buy => JSON.parse(buy.value));

  for (const buy of buys) {
    await Things.fulfillThingBuy(buy.id, residentId, now);
  }

  const text = 'Fulfillment succeeded :shopping_bags:';
  await postEphemeral(residentId, text);

  await ack();
});

app.command('/things-update', async ({ ack, command }) => {
  const commandName = '/things-update';
  const { houseId } = common.beginCommand(commandName, command);

  if (!(await common.isAdmin(app, thingsConf.oauth, command.user_id))) {
    await common.replyAdminOnly(app, thingsConf.oauth, command);
    return;
  }

  const things = await Things.getThings(houseId);

  // TODO: improve this (hacky) implementation
  const view = views.thingsProposeEditView(things, '-admin');
  await common.openView(app, thingsConf.oauth, command.trigger_id, view);

  await ack();
});

app.view('things-propose-edit-admin', async ({ ack, body }) => {
  const actionName = 'things-update-2';
  common.beginAction(actionName, body);

  const { id: thingId } = JSON.parse(common.getInputBlock(body, -1).thing.selected_option.value);
  const thing = await Things.getThing(thingId);

  const view = views.thingsProposeAddView(thing, '-admin');
  await ack({ response_action: 'push', view });
});

app.view('things-propose-callback-admin', async ({ ack, body }) => {
  const actionName = 'things-update-callback';
  const { residentId } = common.beginAction(actionName, body);

  const { thing } = JSON.parse(body.view.private_metadata);
  const { type, name, unit, value, url } = parseThingsEditSubmission(body);

  // Update the thing
  const metadata = { unit, url };
  await Things.editThing(thing.id, type, name, value, metadata, true);

  const text = 'Update succeeded :floppy_disk:';
  await postEphemeral(residentId, text);

  await ack({ response_action: 'clear' });
});

// Buy flow

app.action('things-buy', async ({ ack, body }) => {
  const actionName = 'things-buy';
  const { now, houseId } = common.beginAction(actionName, body);

  const things = await Things.getThings(houseId);
  const accounts = await Things.getActiveAccounts(houseId, now);

  const view = views.thingsBuyView(things, accounts);
  await common.openView(app, thingsConf.oauth, body.trigger_id, view);

  await ack();
});

app.view('things-buy-callback', async ({ ack, body }) => {
  const actionName = 'things-buy-callback';
  const { now, houseId, residentId } = common.beginAction(actionName, body);

  const { id: thingId } = JSON.parse(common.getInputBlock(body, -3).things.selected_option.value);
  const quantity = common.getInputBlock(body, -2).quantity.value;
  const { account } = JSON.parse(common.getInputBlock(body, -1).account.selected_option.value);

  // Perform the buy
  const thing = await Things.getThing(thingId);
  const [ buy ] = await Things.buyThing(houseId, thing.id, residentId, now, account, thing.value, quantity);
  await Polls.submitVote(buy.pollId, residentId, now, YAY);

  const { minVotes } = await Polls.getPoll(buy.pollId);
  const balance = await Things.getAccountBalance(houseId, account, now);

  const text = 'Someone just bought a thing';
  const blocks = views.thingsBuyCallbackView(buy, thing, balance.sum, minVotes);
  const { channel, ts } = await postMessage(text, blocks);
  await Polls.updateMetadata(buy.pollId, { channel, ts });

  await ack();
});

app.action('things-special', async ({ ack, body }) => {
  const actionName = 'things-special';
  const { now, houseId } = common.beginAction(actionName, body);

  const residents = await Admin.getResidents(houseId, now);
  const accounts = await Things.getActiveAccounts(houseId, now);

  const view = views.thingsSpecialBuyView(residents.length, accounts);
  await common.openView(app, thingsConf.oauth, body.trigger_id, view);

  await ack();
});

app.view('things-special-callback', async ({ ack, body }) => {
  const actionName = 'things-special-callback';
  const { now, houseId, residentId } = common.beginAction(actionName, body);

  const title = common.getInputBlock(body, -4).title.value.trim();
  const details = common.getInputBlock(body, -3).details.value.trim();
  const cost = common.getInputBlock(body, -2).cost.value;
  const { account } = JSON.parse(common.getInputBlock(body, -1).account.selected_option.value);

  // Perform the buy
  const [ buy ] = await Things.buySpecialThing(houseId, residentId, now, account, cost, title, details);
  await Polls.submitVote(buy.pollId, residentId, now, YAY);

  const { minVotes } = await Polls.getPoll(buy.pollId);
  const balance = await Things.getAccountBalance(houseId, account, now);

  const text = 'Someone just bought a thing';
  const blocks = views.thingsSpecialBuyCallbackView(buy, balance.sum, minVotes);
  const { channel, ts } = await postMessage(text, blocks);
  await Polls.updateMetadata(buy.pollId, { channel, ts });

  await ack();
});

app.action('things-bought', async ({ ack, body }) => {
  const actionName = 'things-bought';
  const { now, houseId } = common.beginAction(actionName, body);

  const oneWeekAgo = new Date(now.getTime() - 7 * DAY);
  const threeMonthsAgo = new Date(now.getTime() - 90 * DAY);

  const unfulfilledBuys = await Things.getUnfulfilledThingBuys(houseId, now);
  const fulfilledBuys7 = await Things.getFulfilledThingBuys(houseId, oneWeekAgo, now);
  const fulfilledBuys90 = await Things.getFulfilledThingBuys(houseId, threeMonthsAgo, now);
  const view = views.thingsBoughtView(unfulfilledBuys, fulfilledBuys7, fulfilledBuys90);
  await common.openView(app, thingsConf.oauth, body.trigger_id, view);

  await ack();
});

// Proposal flow

app.action('things-propose', async ({ ack, body }) => {
  const actionName = 'things-propose';
  const { now, houseId } = common.beginAction(actionName, body);

  const minVotes = await Things.getThingProposalMinVotes(houseId, now);

  const view = views.thingsProposeView(minVotes);
  await common.openView(app, thingsConf.oauth, body.trigger_id, view);

  await ack();
});

app.view('things-propose-2', async ({ ack, body }) => {
  const actionName = 'things-propose-2';
  const { houseId } = common.beginAction(actionName, body);

  const change = common.getInputBlock(body, -1).change.selected_option.value;

  let things, view;
  switch (change) {
    case 'add':
      view = views.thingsProposeAddView();
      break;
    case 'edit':
      things = await Things.getThings(houseId);
      view = views.thingsProposeEditView(things);
      break;
    case 'delete':
      things = await Things.getThings(houseId);
      view = views.thingsProposeDeleteView(things);
      break;
    default:
      console.log('No match found!');
      return;
  }

  await ack({ response_action: 'push', view });
});

app.view('things-propose-edit', async ({ ack, body }) => {
  const actionName = 'things-propose-edit';
  common.beginAction(actionName, body);

  const { id: thingId } = JSON.parse(common.getInputBlock(body, -1).thing.selected_option.value);
  const thing = await Things.getThing(thingId);

  const view = views.thingsProposeAddView(thing);
  await ack({ response_action: 'push', view });
});

app.view('things-propose-callback', async ({ ack, body }) => {
  const actionName = 'things-propose-callback';
  const { now, houseId, residentId } = common.beginAction(actionName, body);

  let thingId, type, name, value, unit, url, active;
  const privateMetadata = JSON.parse(body.view.private_metadata);

  switch (privateMetadata.change) {
    case 'add':
      // TODO: if thing exists, return ephemeral and exit
      ({ type, name, unit, value, url } = parseThingsEditSubmission(body));
      [ thingId, active ] = [ null, true ];
      break;
    case 'edit':
      ({ type, name, unit, value, url } = parseThingsEditSubmission(body));
      [ thingId, active ] = [ privateMetadata.thing.id, true ];
      break;
    case 'delete':
      ({ id: thingId, type, name } = JSON.parse(common.getInputBlock(body, -1).thing.selected_option.value));
      [ value, unit, url, active ] = [ 0, undefined, undefined, false ];
      break;
    default:
      console.log('No match found!');
      return;
  }

  // Create the thing proposal
  const metadata = { unit, url };
  const [ proposal ] = await Things.createThingProposal(houseId, residentId, thingId, type, name, value, metadata, active, now);
  await Polls.submitVote(proposal.pollId, residentId, now, YAY);

  const { minVotes } = await Polls.getPoll(proposal.pollId);

  const text = 'Someone just proposed a thing edit';
  const blocks = views.thingsProposeCallbackView(privateMetadata, proposal, minVotes);
  const { channel, ts } = await postMessage(text, blocks);
  await Polls.updateMetadata(proposal.pollId, { channel, ts });

  await ack({ response_action: 'clear' });
});

// Voting flow

app.action(/poll-vote/, async ({ ack, body, action }) => {
  const actionName = 'things poll-vote';
  common.beginAction(actionName, body);

  await common.updateVoteCounts(app, thingsConf.oauth, body, action);

  await ack();
});

// Utils

function parseThingsEditSubmission (body) {
  const type = common.parseTitlecase(common.getInputBlock(body, -5).type.value);
  const name = common.parseTitlecase(common.getInputBlock(body, -4).name.value);
  const unit = common.parseLowercase(common.getInputBlock(body, -3).unit.value);
  const value = common.getInputBlock(body, -2).cost.value;
  const url = common.parseUrl(common.getInputBlock(body, -1).url.value);
  return { type, name, unit, value, url };
}

// Launch the app

(async () => {
  const port = process.env.THINGS_PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Things app is running on port ${port} in the ${process.env.NODE_ENV} environment`);
})();

// Fin
