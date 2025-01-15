const { thingsMinPctSpecial, thingsMaxPct, thingsPollLength, thingsSpecialPollLength, thingsProposalPollLength } = require('../config');

const common = require('./common');

// Things Views

const TITLE = common.blockPlaintext('Things');
const DOCS_URL = 'https://docs.chorewheel.zaratan.world/en/latest/tools/things.html';

exports.formatThing = function (thing) {
  if (thing.metadata) {
    return `${thing.name} (${thing.metadata.unit}) - $${thing.value}`;
  } else {
    return `${thing.name} (?) - $${thing.value}`;
  }
};

exports.formatTypedThing = function (thing) {
  return `${thing.type}: ${exports.formatThing(thing)}`;
};

exports.formatBuy = function (buy, url = true) {
  let text;

  if (buy.metadata && buy.metadata.special) {
    text = `Special: ${buy.metadata.title}`;
  } else if (buy.metadata && buy.thingMetadata) {
    text = `${buy.name} (${buy.metadata.quantity} x ${buy.thingMetadata.unit})`;
  } else {
    text = `${buy.name} (?)`;
  }

  if (url && buy.thingMetadata && buy.thingMetadata.url) {
    text = `<${buy.thingMetadata.url}|${text}>`;
  }

  text = `${text} - $${-buy.value}`;
  return text;
};

function getUrlHost (buy) {
  try {
    return (new URL(buy.thingMetadata.url)).host;
  } catch {
    return '';
  }
}

function urlCompare (a, b) {
  const hostA = getUrlHost(a);
  const hostB = getUrlHost(b);
  return hostA.localeCompare(hostB);
}

// Home views

exports.thingsIntroView = function () {
  const header = ':wave::skin-tone-4: Thanks for installing Things!';

  const instructions = `
*Follow these steps* to get set up (must be a workspace admin).
_Setup is easiest if everyone is in the same place, but it's not strictly necessary._

*1.* *Invite* all housemates to the Slack, and wait for them to join.

*2.* Make a list of *5-10 starter things*. Good things:
  • Are used by (almost) everybody.
  • Are non-perishable and can be bought in bulk.
  • Are easy to order (free shipping, etc).

*3.* Set an events channel by calling \`/things-channel\`, which *unlocks the app*.

*4.* Use *\`Edit things list\`* to enter the things you came up with.
  • Make sure to include taxes, etc when inputting the total cost.

*5.* Have the housemates go to the events channel and *upvote the edits*.

Once the things have been fully upvoted, *you're ready to go!* :rocket:
Encourage folks to make buys as they go, and use \`/things-load\` and \`/things-fulfill\` to manage accounts.

_For more details on *Things* functionality, read the <${DOCS_URL}|manual>._
`;

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(instructions));

  return {
    type: 'home',
    blocks,
  };
};

exports.thingsHomeView = function (isActive, accounts) {
  const getMoneybags = sum => ':moneybag:'.repeat(Math.round(Math.sqrt(sum) / 10));

  const header = 'Welcome to Things';
  const textA = `We use *<${DOCS_URL}|Things>* to spend money together.\n\n` +
    'Anyone can propose a buy, which requires *1 upvote per $50*. ' +
    'Special buys require at least *30%* whole-house approval.';
  const textB = 'The house has the *following balances*:\n' +
    accounts.map(account => `\n${getMoneybags(account.sum)}*${account.account}* account: *$${account.sum}*`);

  const actions = [];
  if (isActive) {
    actions.push(common.blockButton('things-buy', ':package: Buy a thing'));
    actions.push(common.blockButton('things-special', ':mirror_ball: Buy special thing'));
    actions.push(common.blockButton('things-propose', ':ledger: Edit things list'));
  }
  actions.push(common.blockButton('things-bought', ':bar_chart: See bought things'));

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(textA));
  blocks.push(common.blockSection(common.feedbackLink));
  blocks.push(common.blockDivider());
  blocks.push(common.blockSection(textB));
  blocks.push(common.blockActions(actions));

  return {
    type: 'home',
    blocks,
  };
};

// Slash commands

exports.thingsLoadView = function () {
  const header = 'Load an account';

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockInput(
    'Account to load',
    {
      action_id: 'account',
      type: 'plain_text_input',
      placeholder: common.blockPlaintext('Account to load (i.e. General, Major Purchases, etc)'),
    },
  ));
  blocks.push(common.blockInput(
    'Amount to load',
    {
      action_id: 'amount',
      type: 'number_input',
      is_decimal_allowed: false,
      placeholder: common.blockPlaintext('Enter amount to load'),
    },
  ));

  return {
    type: 'modal',
    callback_id: 'things-load-2',
    title: TITLE,
    close: common.CLOSE,
    submit: common.SUBMIT,
    blocks,
  };
};

exports.thingsLoadView2 = function (account, currentAmount, amount) {
  const header = 'Load an account';
  const text = `You are loading *$${amount}* into the *${account}* account.\n\n` +
    `The new balance will be *$${currentAmount + amount}*.`;

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(text));

  return {
    type: 'modal',
    callback_id: 'things-load-callback',
    private_metadata: JSON.stringify({ account, amount }),
    title: TITLE,
    close: common.BACK,
    submit: common.SUBMIT,
    blocks,
  };
};

exports.thingsFulfillView = function (unfulfilledBuys) {
  const header = 'Fulfill some buys';
  const text = 'Once you\'ve fulfilled some buys, you can check them off here.';

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(text));
  blocks.push(common.blockDivider());
  blocks.push(common.blockInput(
    'Buys to fulfill',
    {
      action_id: 'buys',
      type: 'multi_static_select',
      placeholder: common.blockPlaintext('Choose some buys'),
      options: unfulfilledBuys
        .filter(buy => buy.resolvedAt)
        .map((buy) => {
          return {
            value: JSON.stringify({ id: buy.id }),
            text: common.blockPlaintext(exports.formatBuy(buy, false).slice(0, 75)),
          };
        }),
    },
  ));

  return {
    type: 'modal',
    callback_id: 'things-fulfill-callback',
    title: TITLE,
    close: common.CLOSE,
    submit: common.SUBMIT,
    blocks,
  };
};

// Core actions

exports.thingsBuyView = function (things, accounts) {
  const header = 'Buy a thing';
  const mainText = 'Choose something to buy. Make sure you have support for large buys!';

  const types = new Set(things.map(thing => thing.type));

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(mainText));
  blocks.push(common.blockInput(
    'Thing to buy',
    {
      action_id: 'things',
      type: 'static_select',
      placeholder: common.blockPlaintext('Choose a thing'),
      option_groups: [ ...types ].map(type =>
        common.blockOptionGroup(
          type,
          things
            .filter(thing => thing.type === type)
            .map((thing) => {
              return {
                value: JSON.stringify({ id: thing.id }),
                text: common.blockPlaintext(exports.formatThing(thing)),
              };
            }),
        ),
      ),
    },
  ));
  blocks.push(common.blockInput(
    'Amount to buy',
    {
      action_id: 'quantity',
      type: 'number_input',
      initial_value: '1',
      min_value: '0',
      is_decimal_allowed: false,
      placeholder: common.blockPlaintext('Choose number of units'),
    },
  ));
  blocks.push(common.blockInput(
    'Account to buy from',
    {
      action_id: 'account',
      type: 'static_select',
      placeholder: common.blockPlaintext('Choose an account'),
      options: accounts.map((account) => {
        return {
          value: JSON.stringify({ account: account.account }),
          text: common.blockPlaintext(`${account.account}: $${account.sum}`),
        };
      }),
    },
  ));

  return {
    type: 'modal',
    callback_id: 'things-buy-callback',
    title: TITLE,
    close: common.CLOSE,
    submit: common.SUBMIT,
    blocks,
  };
};

exports.thingsBuyCallbackView = function (buy, thing, balance, minVotes) {
  // TODO: clean this up somehow
  buy.type = thing.type;
  buy.name = thing.name;
  buy.thingMetadata = thing.metadata;
  const formattedBuy = exports.formatBuy(buy);

  const mainText = `*<@${buy.boughtBy}>* bought *${formattedBuy}*. ` +
    `There's *$${balance}* left in the *${buy.account}* account :money_with_wings:`;

  const blocks = [];
  blocks.push(common.blockSection(mainText));
  blocks.push(common.blockSection(common.makeVoteText(minVotes, thingsPollLength)));
  blocks.push(common.blockActions(common.makeVoteButtons(buy.pollId, 1, 0)));
  return blocks;
};

exports.thingsSpecialBuyView = function (numResidents, accounts) {
  const minVotes = Math.ceil(thingsMinPctSpecial * numResidents);
  const maxVotes = Math.ceil(thingsMaxPct * numResidents);

  const header = 'Buy special thing';
  const mainText = 'Propose a special buy. ' +
    `Special buys are more flexible, but need a minimum of *${minVotes} - ${maxVotes} upvote(s),* depending on price.\n\n` +
    'Add relevant information about the buy, including any delivery information. ' +
    'Special buys are fulfilled by the person who proposes them, and then reimbursed. ' +
    'Reimbursements are capped at the amount requested.';

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(mainText));
  blocks.push(common.blockInput(
    'Thing to buy',
    {
      action_id: 'title',
      type: 'plain_text_input',
      placeholder: common.blockPlaintext('Short description of the thing'),
    },
  ));
  blocks.push(common.blockInput(
    'Additional details',
    {
      action_id: 'details',
      type: 'plain_text_input',
      multiline: true,
      placeholder: common.blockPlaintext('Add any additional details'),
    },
  ));
  blocks.push(common.blockInput(
    'Total cost',
    {
      action_id: 'cost',
      type: 'number_input',
      min_value: '1',
      is_decimal_allowed: false,
      placeholder: common.blockPlaintext('Provide the total cost (including tax and shipping)'),
    },
  ));
  blocks.push(common.blockInput(
    'Account to buy from',
    {
      action_id: 'account',
      type: 'static_select',
      placeholder: common.blockPlaintext('Choose an account'),
      options: accounts.map((account) => {
        return {
          value: JSON.stringify({ account: account.account }),
          text: common.blockPlaintext(`${account.account}: $${account.sum}`),
        };
      }),
    },
  ));

  return {
    type: 'modal',
    callback_id: 'things-special-callback',
    title: TITLE,
    close: common.CLOSE,
    submit: common.SUBMIT,
    blocks,
  };
};

exports.thingsSpecialBuyCallbackView = function (buy, balance, minVotes) {
  const textA = `*<@${buy.boughtBy}>* bought the following for *$${-buy.value}*:`;
  const textB = `There's *$${balance}* left in the *${buy.account}* account :money_with_wings:`;

  const blocks = [];
  blocks.push(common.blockSection(textA));
  blocks.push(common.blockSection(`*${buy.metadata.title}*`));
  blocks.push(common.blockSection(buy.metadata.details));
  blocks.push(common.blockSection(textB));
  blocks.push(common.blockSection(common.makeVoteText(minVotes, thingsSpecialPollLength)));
  blocks.push(common.blockActions(common.makeVoteButtons(buy.pollId, 1, 0)));
  return blocks;
};

exports.thingsBoughtView = function (unfulfilledBuys, fulfilledBuys7, fulfilledBuys90) {
  const header = 'Bought things';
  const mainText = 'Things bought by the house.\n\n' +
    '*Pending* buys are proposed but not yet approved. ' +
    '*Unfulfilled* buys are approved but not yet ordered. ' +
    '*Fulfilled* buys have been ordered, and show *total amounts* over a time period ' +
    '(excluding special buys)';

  const pendingBuysText = unfulfilledBuys
    .filter(buy => buy.resolvedAt === null)
    .map(buy => exports.formatBuy(buy))
    .join('\n');

  const confirmedBuysText = unfulfilledBuys
    .filter(buy => buy.resolvedAt !== null)
    .sort((a, b) => urlCompare(a, b))
    .map(buy => exports.formatBuy(buy))
    .join('\n');

  const fulfilledBuys7Text = fulfilledBuys7
    .map(buy => `${buy.name} ($${-buy.value})`)
    .join('\n');

  const fulfilledBuys90Text = fulfilledBuys90
    .map(buy => `${buy.name} ($${-buy.value})`)
    .join('\n');

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(mainText));
  blocks.push(common.blockDivider());
  blocks.push(common.blockSection(`*Pending:*\n${pendingBuysText}`));
  blocks.push(common.blockSection(`*Unfulfilled:*\n${confirmedBuysText}`));
  blocks.push(common.blockSection(`*Fulfilled in the last 7 days:*\n${fulfilledBuys7Text}`));
  blocks.push(common.blockSection(`*Fulfilled in the last 90 days:*\n${fulfilledBuys90Text}`));

  return {
    type: 'modal',
    title: TITLE,
    close: common.CLOSE,
    blocks,
  };
};

// Thing proposals

exports.thingsProposeView = function (minVotes) {
  const header = 'Edit things list';
  const mainText = 'Choosing a list of things in advance means fewer approvals are needed for any single buy. ' +
    'It\'s also helpful to keep the list up-to-date as costs and inventories change.\n\n' +
    'Make sure to consider taxes and shipping when entering costs, otherwise you might accidentally overspend.\n\n' +
    `As a major house decision, a minimum of *${minVotes} upvote(s)* are required.`;

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(mainText));
  blocks.push(common.blockDivider());
  blocks.push(common.blockInput(
    'What change would you like to make?',
    {
      type: 'radio_buttons',
      action_id: 'change',
      options: [
        { value: 'add', text: common.blockMarkdown('*Add* a new thing') },
        { value: 'edit', text: common.blockMarkdown('*Change* an existing thing') },
        { value: 'delete', text: common.blockMarkdown('*Remove* an existing thing') },
      ],
    },
  ));

  return {
    type: 'modal',
    callback_id: 'things-propose-2',
    title: TITLE,
    close: common.CLOSE,
    submit: common.NEXT,
    blocks,
  };
};

exports.thingsProposeEditView = function (things, branch = '') {
  const header = 'Edit things list';
  const mainText = 'Change an existing thing.';

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(mainText));
  blocks.push(common.blockDivider());
  blocks.push(common.blockInput(
    'Choose a thing to edit',
    {
      type: 'static_select',
      action_id: 'thing',
      placeholder: common.blockPlaintext('Choose a thing'),
      options: mapThings(things),
    },
  ));

  return {
    type: 'modal',
    callback_id: `things-propose-edit${branch}`,
    title: TITLE,
    close: common.BACK,
    submit: common.NEXT,
    blocks,
  };
};

// NOTE: used for both add and edit flows
exports.thingsProposeAddView = function (thing, branch = '') {
  const header = 'Edit things list';
  let metadata, mainText;

  if (thing) {
    metadata = JSON.stringify({ change: 'edit', thing: { id: thing.id, type: thing.type, name: thing.name } });
    mainText = 'Change an existing thing.';
  } else {
    metadata = JSON.stringify({ change: 'add' });
    mainText = 'Add a new thing.';
  }

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(mainText));
  blocks.push(common.blockDivider());
  blocks.push(common.blockInput(
    'Category',
    {
      action_id: 'type',
      type: 'plain_text_input',
      initial_value: (thing) ? thing.type : undefined,
      placeholder: common.blockPlaintext('Category of the thing, e.g. Pantry, Beverage'),
    },
  ));
  blocks.push(common.blockInput(
    'Name',
    {
      action_id: 'name',
      type: 'plain_text_input',
      initial_value: (thing) ? thing.name : undefined,
      placeholder: common.blockPlaintext('Name of the thing, e.g. Oat Milk, Salt'),
    },
  ));
  blocks.push(common.blockInput(
    'Unit',
    {
      action_id: 'unit',
      type: 'plain_text_input',
      initial_value: (thing) ? thing.metadata.unit : undefined,
      placeholder: common.blockPlaintext('Unit sold, e.g. 2 x 24 oz, 2 dozen'),
    },
  ));
  blocks.push(common.blockInput(
    'Cost',
    {
      action_id: 'cost',
      type: 'number_input',
      min_value: '1',
      is_decimal_allowed: false,
      initial_value: (thing) ? thing.value.toString() : undefined,
      placeholder: common.blockPlaintext('Cost of the thing (including tax & shipping)'),
    },
  ));
  blocks.push(common.blockInput(
    'Link',
    {
      action_id: 'url',
      type: 'url_text_input',
      initial_value: (thing) ? thing.metadata.url : undefined,
      placeholder: common.blockPlaintext('Link to the thing'),
    },
  ));

  return {
    type: 'modal',
    callback_id: `things-propose-callback${branch}`,
    private_metadata: metadata,
    title: TITLE,
    close: common.BACK,
    submit: common.SUBMIT,
    blocks,
  };
};

exports.thingsProposeDeleteView = function (things) {
  const header = 'Edit things list';
  const mainText = 'Remove an existing thing.';

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(mainText));
  blocks.push(common.blockInput(
    'Thing to remove',
    {
      action_id: 'thing',
      type: 'static_select',
      placeholder: common.blockPlaintext('Choose a thing'),
      options: mapThings(things),
    },
  ));

  return {
    type: 'modal',
    callback_id: 'things-propose-callback',
    private_metadata: JSON.stringify({ change: 'delete' }),
    title: TITLE,
    close: common.BACK,
    submit: common.SUBMIT,
    blocks,
  };
};

exports.thingsProposeCallbackView = function (metadata, proposal, minVotes) {
  let mainText;
  switch (metadata.change) {
    case 'add':
      mainText = `*<@${proposal.proposedBy}>* wants to *add* a thing:`;
      break;
    case 'edit':
      mainText = `*<@${proposal.proposedBy}>* wants to *edit* the *${metadata.thing.type}: ${metadata.thing.name}* thing:`;
      break;
    case 'delete':
      mainText = `*<@${proposal.proposedBy}>* wants to *delete* a thing:`;
      break;
  }

  const blocks = [];
  blocks.push(common.blockSection(mainText));
  blocks.push(common.blockSection(`*${proposal.type}: ${proposal.name}*`));

  if (proposal.value) {
    blocks.push(common.blockSection(`${proposal.metadata.unit} - $${proposal.value}`));
  }

  if (proposal.metadata.url) {
    blocks.push(common.blockSection(`<${proposal.metadata.url}|Link>`));
  }

  blocks.push(common.blockSection(common.makeVoteText(minVotes, thingsProposalPollLength)));
  blocks.push(common.blockActions(common.makeVoteButtons(proposal.pollId, 1, 0)));
  return blocks;
};

// Internal

function mapThings (things) {
  return things.map((thing) => {
    return {
      value: JSON.stringify({ id: thing.id, type: thing.type, name: thing.name }),
      text: common.blockPlaintext(exports.formatTypedThing(thing)),
    };
  });
}
