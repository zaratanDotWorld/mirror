const { expect } = require('chai');
const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');

chai.use(chaiAsPromised);

const { Things, Hearts, Polls, Admin } = require('../src/core/index');
const { NAY, YAY, HOUR, DAY, HEART_UNKNOWN } = require('../src/constants');
const { thingsPollLength, thingsSpecialPollLength, thingsProposalPollLength } = require('../src/config');
const testHelpers = require('./helpers');

describe('Things', async () => {
  const HOUSE = testHelpers.generateSlackId();
  const RESIDENT1 = testHelpers.generateSlackId();
  const RESIDENT2 = testHelpers.generateSlackId();
  const RESIDENT3 = testHelpers.generateSlackId();
  const RESIDENT4 = testHelpers.generateSlackId();

  const GENERAL = 'General';
  const SPECIAL = 'Special';

  const PANTRY = 'pantry';
  const SOAP = 'soap';
  const RICE = 'rice';

  let now;
  let soon;
  let tomorrow;
  let challengeEnd;
  let challengeEndSpecial;
  let proposalEnd;

  beforeEach(async () => {
    now = new Date();
    soon = new Date(now.getTime() + HOUR);
    tomorrow = new Date(now.getTime() + DAY);
    challengeEnd = new Date(now.getTime() + thingsPollLength);
    challengeEndSpecial = new Date(now.getTime() + thingsSpecialPollLength);
    proposalEnd = new Date(now.getTime() + thingsProposalPollLength);

    await Admin.addHouse(HOUSE);
    await Admin.activateResident(HOUSE, RESIDENT1, now);
    await Admin.activateResident(HOUSE, RESIDENT2, now);
    await Admin.activateResident(HOUSE, RESIDENT3, now);
    await Admin.activateResident(HOUSE, RESIDENT4, now);
  });

  afterEach(async () => {
    await testHelpers.resetDb();
  });

  describe('managing the list', async () => {
    it('can manage items on the list', async () => {
      const [ soap ] = await Things.addThing(HOUSE, PANTRY, SOAP, 10, {});
      const [ rice ] = await Things.addThing(HOUSE, PANTRY, RICE, 60, {});

      let things;
      things = await Things.getThings(HOUSE);
      expect(things.length).to.equal(2);
      // Sorted alphabetically
      expect(things[0].name).to.equal(RICE);
      expect(things[1].name).to.equal(SOAP);

      await Things.editThing(soap.id, PANTRY, SOAP, 0, {}, false);
      await Things.editThing(rice.id, PANTRY, RICE, 20, {}, true);

      things = await Things.getThings(HOUSE);
      expect(things.length).to.equal(1);
      expect(things[0].value).to.equal(20);
    });

    it('can get a thing by id', async () => {
      const [ soap ] = await Things.addThing(HOUSE, PANTRY, SOAP, 10, {});

      const thing = await Things.getThing(soap.id);
      expect(thing.name).to.equal(soap.name);
    });
  });

  describe('buying things from the list', async () => {
    let soap;
    let rice;

    beforeEach(async () => {
      [ soap ] = await Things.addThing(HOUSE, PANTRY, SOAP, 10, { unit: '20 bars' });
      [ rice ] = await Things.addThing(HOUSE, PANTRY, RICE, 60, { unit: '25 lbs' });
    });

    it('can load funds into different accounts', async () => {
      await Things.loadAccount(HOUSE, GENERAL, RESIDENT1, now, 100);
      await Things.loadAccount(HOUSE, SPECIAL, RESIDENT1, now, 250);

      let balance;
      balance = await Things.getAccountBalance(HOUSE, GENERAL, now);
      expect(balance.sum).to.equal(100);

      balance = await Things.getAccountBalance(HOUSE, SPECIAL, now);
      expect(balance.sum).to.equal(250);
    });

    it('can return active accounts', async () => {
      let accounts;

      accounts = await Things.getActiveAccounts(HOUSE, now);
      expect(accounts.length).to.equal(0);

      await Things.loadAccount(HOUSE, GENERAL, RESIDENT1, now, 100);

      accounts = await Things.getActiveAccounts(HOUSE, now);
      expect(accounts.length).to.equal(1);
      expect(accounts[0].account).to.equal(GENERAL);
      expect(accounts[0].sum).to.equal(100);

      await Things.loadAccount(HOUSE, GENERAL, RESIDENT1, now, -100);

      accounts = await Things.getActiveAccounts(HOUSE, now);
      expect(accounts.length).to.equal(0);
    });

    it('can buy things from the list', async () => {
      await Things.loadAccount(HOUSE, GENERAL, RESIDENT1, now, 100);
      await Things.loadAccount(HOUSE, SPECIAL, RESIDENT1, now, 250);

      let buy;
      [ buy ] = await Things.buyThing(HOUSE, rice.id, RESIDENT1, now, GENERAL, 60, 1);
      expect(buy.value).to.equal(-60);
      expect(buy.metadata.quantity).to.equal(1);

      let balance;
      balance = await Things.getAccountBalance(HOUSE, GENERAL, now);
      expect(balance.sum).to.equal(40);

      [ buy ] = await Things.buyThing(HOUSE, soap.id, RESIDENT1, now, SPECIAL, 10, 12);
      expect(buy.value).to.equal(-120);
      expect(buy.metadata.quantity).to.equal(12);

      balance = await Things.getAccountBalance(HOUSE, SPECIAL, now);
      expect(balance.sum).to.equal(130);
    });

    it('cannot buy a thing with insufficient funds', async () => {
      await Things.loadAccount(HOUSE, GENERAL, RESIDENT1, now, 20);

      await expect(Things.buyThing(HOUSE, soap.id, RESIDENT1, now, GENERAL, 10, 3))
        .to.be.rejectedWith('Insufficient funds!');

      await Things.buyThing(HOUSE, soap.id, RESIDENT1, now, GENERAL, 10, 2);
    });

    it('can get the minimum votes for a buy', async () => {
      let minVotes;

      minVotes = await Things.getThingBuyMinVotes(HOUSE, RESIDENT1, rice.id, 10, now);
      expect(minVotes).to.equal(1);

      minVotes = await Things.getThingBuyMinVotes(HOUSE, RESIDENT1, rice.id, 70, now);
      expect(minVotes).to.equal(2);

      // max: ceil( 4 residents * 60% ) = 3
      minVotes = await Things.getThingBuyMinVotes(HOUSE, RESIDENT1, rice.id, 200, now);
      expect(minVotes).to.equal(3);
    });

    it('can scale the minimum votes based on hearts', async () => {
      let minVotes;
      minVotes = await Things.getThingBuyMinVotes(HOUSE, RESIDENT1, rice.id, 100, now);
      expect(minVotes).to.equal(2);

      // 2 hearts (+ 60% = 3.2)
      await Hearts.generateHearts(HOUSE, RESIDENT1, HEART_UNKNOWN, now, 2);
      minVotes = await Things.getThingBuyMinVotes(HOUSE, RESIDENT1, rice.id, 100, soon);
      expect(minVotes).to.equal(4);

      // 8 hearts (- 60% = 0.8)
      await Hearts.generateHearts(HOUSE, RESIDENT1, HEART_UNKNOWN, now, 6);
      minVotes = await Things.getThingBuyMinVotes(HOUSE, RESIDENT1, rice.id, 100, soon);
      expect(minVotes).to.equal(1);
    });

    it('can affirm a buy', async () => {
      await Things.loadAccount(HOUSE, GENERAL, RESIDENT1, now, 100);

      let [ buy ] = await Things.buyThing(HOUSE, soap.id, RESIDENT1, now, GENERAL, 10, 1);

      await Polls.submitVote(buy.pollId, RESIDENT1, now, YAY);

      await Things.resolveThingBuy(buy.id, challengeEnd);

      const balance = await Things.getAccountBalance(HOUSE, GENERAL, challengeEnd);
      expect(balance.sum).to.equal(90);

      buy = await Things.getThingBuy(buy.id);
      expect(buy.valid).to.be.true;
      expect(buy.resolvedAt.getTime()).to.equal(challengeEnd.getTime());
    });

    it('can reject a buy', async () => {
      await Things.loadAccount(HOUSE, GENERAL, RESIDENT1, now, 100);

      let [ buy ] = await Things.buyThing(HOUSE, soap.id, RESIDENT1, now, GENERAL, 10, 1);

      await Polls.submitVote(buy.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(buy.pollId, RESIDENT2, now, NAY);

      await Things.resolveThingBuy(buy.id, challengeEnd);

      const balance = await Things.getAccountBalance(HOUSE, GENERAL, challengeEnd);
      expect(balance.sum).to.equal(100);

      buy = await Things.getThingBuy(buy.id);
      expect(buy.valid).to.be.false;
      expect(buy.resolvedAt.getTime()).to.equal(challengeEnd.getTime());
    });

    it('can negate a buy if quorum is not reached', async () => {
      await Things.loadAccount(HOUSE, GENERAL, RESIDENT1, now, 100);

      // Need 1 affirmative vote per $50
      let [ buy ] = await Things.buyThing(HOUSE, rice.id, RESIDENT1, now, GENERAL, 60, 1);

      await Polls.submitVote(buy.pollId, RESIDENT1, now, YAY);

      await Things.resolveThingBuy(buy.id, challengeEnd);

      buy = await Things.getThingBuy(buy.id);
      expect(buy.valid).to.be.false;
    });

    it('cannot resolve a buy before the poll is closed', async () => {
      await Things.loadAccount(HOUSE, GENERAL, RESIDENT1, now, 100);

      const [ buy ] = await Things.buyThing(HOUSE, soap.id, RESIDENT1, now, GENERAL, 10, 1);

      await expect(Things.resolveThingBuy(buy.id, soon))
        .to.be.rejectedWith('Poll not closed!');
    });

    it('cannot resolve a buy twice', async () => {
      await Things.loadAccount(HOUSE, GENERAL, RESIDENT1, now, 100);

      let [ buy ] = await Things.buyThing(HOUSE, soap.id, RESIDENT1, now, GENERAL, 10, 1);

      await Polls.submitVote(buy.pollId, RESIDENT1, now, YAY);

      await Things.resolveThingBuy(buy.id, challengeEnd);

      [ buy ] = await Things.resolveThingBuy(buy.id, challengeEnd);
      expect(buy).to.be.undefined;
    });

    it('can resolve buys in bulk', async () => {
      await Things.loadAccount(HOUSE, GENERAL, RESIDENT1, now, 100);

      const [ thingBuy1 ] = await Things.buyThing(HOUSE, rice.id, RESIDENT1, now, GENERAL, 10, 1);
      const [ thingBuy2 ] = await Things.buyThing(HOUSE, soap.id, RESIDENT1, now, GENERAL, 10, 1);
      const [ thingBuy3 ] = await Things.buyThing(HOUSE, rice.id, RESIDENT1, soon, GENERAL, 10, 1);

      await Polls.submitVote(thingBuy1.pollId, RESIDENT1, now, YAY);

      await Things.resolveThingBuys(HOUSE, challengeEnd);

      const resolvedBuy1 = await Things.getThingBuy(thingBuy1.id);
      expect(resolvedBuy1.valid).to.be.true;
      expect(resolvedBuy1.resolvedAt.getTime()).to.equal(challengeEnd.getTime());

      const resolvedBuy2 = await Things.getThingBuy(thingBuy2.id);
      expect(resolvedBuy2.valid).to.be.false;
      expect(resolvedBuy2.resolvedAt.getTime()).to.equal(challengeEnd.getTime());

      // This buy was not resolved as poll is not yet closed
      const resolvedBuy3 = await Things.getThingBuy(thingBuy3.id);
      expect(resolvedBuy3.valid).to.be.true;
      expect(resolvedBuy3.resolvedAt).to.equal(null);
    });

    it('can get a list of unfulfilled buys', async () => {
      await Things.loadAccount(HOUSE, GENERAL, RESIDENT1, now, 100);

      const [ buy ] = await Things.buyThing(HOUSE, soap.id, RESIDENT1, now, GENERAL, 10, 1);

      await Polls.submitVote(buy.pollId, RESIDENT1, now, NAY);

      let unfulfilledBuys;
      unfulfilledBuys = await Things.getUnfulfilledThingBuys(HOUSE, challengeEnd);
      expect(unfulfilledBuys.length).to.equal(1);
      expect(unfulfilledBuys[0].thingMetadata.unit).to.equal('20 bars');
      expect(unfulfilledBuys[0].metadata.quantity).to.equal(1);

      await Things.resolveThingBuy(buy.id, challengeEnd);

      unfulfilledBuys = await Things.getUnfulfilledThingBuys(HOUSE, challengeEnd);
      expect(unfulfilledBuys.length).to.equal(0);
    });

    it('can fulfill a buy', async () => {
      await Things.loadAccount(HOUSE, GENERAL, RESIDENT1, now, 100);

      const [ buy ] = await Things.buyThing(HOUSE, soap.id, RESIDENT1, now, GENERAL, 10, 1);

      await Polls.submitVote(buy.pollId, RESIDENT1, now, YAY);
      await Things.resolveThingBuy(buy.id, challengeEnd);

      const [ fulfilledBuy ] = await Things.fulfillThingBuy(buy.id, RESIDENT2, challengeEnd);
      expect(fulfilledBuy.fulfilledAt.getTime()).to.equal(challengeEnd.getTime());
      expect(fulfilledBuy.fulfilledBy).to.equal(RESIDENT2);
    });

    it('can get a list of fulfilled buys within a time range', async () => {
      await Things.loadAccount(HOUSE, GENERAL, RESIDENT1, now, 100);

      const nextWeek = new Date(now.getTime() + 7 * DAY);
      const nextMonth = new Date(now.getTime() + 28 * DAY);

      const [ thingBuy1 ] = await Things.buyThing(HOUSE, rice.id, RESIDENT1, now, GENERAL, 10, 1);
      const [ thingBuy2 ] = await Things.buyThing(HOUSE, soap.id, RESIDENT1, nextWeek, GENERAL, 15, 1);
      const [ thingBuy3 ] = await Things.buyThing(HOUSE, rice.id, RESIDENT1, nextMonth, GENERAL, 20, 1);

      await Polls.submitVote(thingBuy1.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(thingBuy2.pollId, RESIDENT1, nextWeek, YAY);
      await Polls.submitVote(thingBuy3.pollId, RESIDENT1, nextMonth, YAY);

      const nextWeekChallengeEnd = new Date(nextWeek.getTime() + thingsPollLength);
      const nextMonthChallengeEnd = new Date(nextMonth.getTime() + thingsPollLength);

      await Things.resolveThingBuy(thingBuy1.id, challengeEnd);
      await Things.resolveThingBuy(thingBuy2.id, nextWeekChallengeEnd);
      await Things.resolveThingBuy(thingBuy3.id, nextMonthChallengeEnd);

      let fulfilledBuys;

      fulfilledBuys = await Things.getFulfilledThingBuys(HOUSE, now, nextMonthChallengeEnd);
      expect(fulfilledBuys.length).to.equal(0);

      await Things.fulfillThingBuy(thingBuy1.id, RESIDENT1, challengeEnd);
      await Things.fulfillThingBuy(thingBuy2.id, RESIDENT1, nextWeekChallengeEnd);
      await Things.fulfillThingBuy(thingBuy3.id, RESIDENT1, nextMonthChallengeEnd);

      // first
      fulfilledBuys = await Things.getFulfilledThingBuys(HOUSE, now, challengeEnd);
      expect(fulfilledBuys.length).to.equal(1);
      expect(fulfilledBuys.find(buy => buy.name === RICE).value).to.equal(-10);

      // all three
      fulfilledBuys = await Things.getFulfilledThingBuys(HOUSE, now, nextMonthChallengeEnd);
      expect(fulfilledBuys.length).to.equal(2);
      expect(fulfilledBuys.find(buy => buy.name === RICE).value).to.equal(-30);
      expect(fulfilledBuys.find(buy => buy.name === SOAP).value).to.equal(-15);

      // last two
      fulfilledBuys = await Things.getFulfilledThingBuys(HOUSE, nextWeekChallengeEnd, nextMonthChallengeEnd);
      expect(fulfilledBuys.length).to.equal(2);
      expect(fulfilledBuys.find(buy => buy.name === RICE).value).to.equal(-20);
      expect(fulfilledBuys.find(buy => buy.name === SOAP).value).to.equal(-15);
    });

    it('can check if a house is active using buys', async () => {
      const nextWeek = new Date(now.getTime() + 7 * DAY);

      await Things.loadAccount(HOUSE, GENERAL, RESIDENT1, now, 100);
      await Things.buyThing(HOUSE, soap.id, RESIDENT1, now, GENERAL, 60, 1);

      let active;
      active = await Admin.houseActive(HOUSE, 'ThingBuy', 'boughtAt', now, tomorrow);
      expect(active).to.be.true;

      active = await Admin.houseActive(HOUSE, 'ThingBuy', 'boughtAt', tomorrow, nextWeek);
      expect(active).to.be.false;
    });
  });

  describe('buying special things', async () => {
    it('can buy a special thing', async () => {
      await Things.loadAccount(HOUSE, GENERAL, RESIDENT1, now, 250);

      const title = '2x4 IKEA KALLAX bookshelf';
      const details = 'Ordered from ikea.com, shipping included';
      const [ buy ] = await Things.buySpecialThing(HOUSE, RESIDENT1, now, GENERAL, 200, title, details);
      expect(buy.value).to.equal(-200);
      expect(buy.metadata.title).to.equal(title);
      expect(buy.metadata.details).to.equal(details);
      expect(buy.metadata.special).to.be.true;

      const balance = await Things.getAccountBalance(HOUSE, GENERAL, now);
      expect(balance.sum).to.equal(50);
    });

    it('can affirm a special buy', async () => {
      await Things.loadAccount(HOUSE, GENERAL, RESIDENT1, now, 250);

      let [ buy ] = await Things.buySpecialThing(HOUSE, RESIDENT1, now, GENERAL, 200, 'special', 'details');

      await Polls.submitVote(buy.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(buy.pollId, RESIDENT2, now, YAY);
      await Polls.submitVote(buy.pollId, RESIDENT3, now, YAY);

      // Special buys have a longer voting window
      await expect(Things.resolveThingBuy(buy.id, challengeEnd))
        .to.be.rejectedWith('Poll not closed!');

      await Things.resolveThingBuy(buy.id, challengeEndSpecial);

      const balance = await Things.getAccountBalance(HOUSE, GENERAL, challengeEndSpecial);
      expect(balance.sum).to.equal(50);

      buy = await Things.getThingBuy(buy.id);
      expect(buy.valid).to.be.true;
      expect(buy.resolvedAt.getTime()).to.equal(challengeEndSpecial.getTime());
    });

    it('can reject a special buy', async () => {
      await Things.loadAccount(HOUSE, GENERAL, RESIDENT1, now, 250);

      let [ buy ] = await Things.buySpecialThing(HOUSE, RESIDENT1, now, GENERAL, 200, 'special', 'details');

      await Polls.submitVote(buy.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(buy.pollId, RESIDENT2, now, YAY);

      await Things.resolveThingBuy(buy.id, challengeEndSpecial);

      const balance = await Things.getAccountBalance(HOUSE, GENERAL, challengeEndSpecial);
      expect(balance.sum).to.equal(250);

      buy = await Things.getThingBuy(buy.id);
      expect(buy.valid).to.be.false;
      expect(buy.resolvedAt.getTime()).to.equal(challengeEndSpecial.getTime());
    });

    it('can get the minimum votes for a special buy', async () => {
      let minVotes;

      // min: ceil( 4 residents * 30% ) = 2
      minVotes = await Things.getThingBuyMinVotes(HOUSE, RESIDENT1, null, 10, now);
      expect(minVotes).to.equal(2);

      minVotes = await Things.getThingBuyMinVotes(HOUSE, RESIDENT1, null, 100, now);
      expect(minVotes).to.equal(2);

      // max: ceil( 4 residents * 60% ) = 3
      minVotes = await Things.getThingBuyMinVotes(HOUSE, RESIDENT1, null, 300, now);
      expect(minVotes).to.equal(3);
    });

    it('can get a list of unfulfilled special buys', async () => {
      await Things.loadAccount(HOUSE, GENERAL, RESIDENT1, now, 500);

      await Things.buySpecialThing(HOUSE, RESIDENT1, now, GENERAL, 100, 'special1', 'details');
      await Things.buySpecialThing(HOUSE, RESIDENT1, now, GENERAL, 100, 'special2', 'details');

      const unfulfilledBuys = await Things.getUnfulfilledThingBuys(HOUSE, now);
      expect(unfulfilledBuys.length).to.equal(2);
    });
  });

  describe('editing things', async () => {
    let things, proposal;

    beforeEach(async () => {
      [ things, proposal ] = [ undefined, undefined ];
    });

    it('can add a thing', async () => {
      things = await Things.getThings(HOUSE);
      expect(things.length).to.equal(0);

      const unit = '25 lbs';
      [ proposal ] = await Things.createThingProposal(HOUSE, RESIDENT1, null, PANTRY, RICE, 20, { unit }, true, now);

      await Polls.submitVote(proposal.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(proposal.pollId, RESIDENT2, now, YAY);

      await Things.resolveThingProposal(proposal.id, proposalEnd);

      things = await Things.getThings(HOUSE);
      expect(things.length).to.equal(1);
      expect(things[0].type).to.equal(PANTRY);
      expect(things[0].name).to.equal(RICE);
      expect(things[0].metadata.unit).to.equal(unit);
    });

    it('can overwrite an existing thing', async () => {
      things = await Things.getThings(HOUSE);
      expect(things.length).to.equal(0);

      let unit = '25 lbs';
      [ proposal ] = await Things.createThingProposal(HOUSE, RESIDENT1, null, PANTRY, RICE, 20, { unit }, true, now);

      await Polls.submitVote(proposal.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(proposal.pollId, RESIDENT2, now, YAY);

      await Things.resolveThingProposal(proposal.id, proposalEnd);

      things = await Things.getThings(HOUSE);
      expect(things.length).to.equal(1);
      expect(things[0].type).to.equal(PANTRY);
      expect(things[0].name).to.equal(RICE);
      expect(things[0].value).to.equal(20);
      expect(things[0].metadata.unit).to.equal(unit);

      unit = '50 lbs';
      [ proposal ] = await Things.createThingProposal(HOUSE, RESIDENT1, null, PANTRY, RICE, 30, { unit }, true, now);

      await Polls.submitVote(proposal.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(proposal.pollId, RESIDENT2, now, YAY);

      await Things.resolveThingProposal(proposal.id, proposalEnd);
      things = await Things.getThings(HOUSE);
      expect(things.length).to.equal(1);
      expect(things[0].type).to.equal(PANTRY);
      expect(things[0].name).to.equal(RICE);
      expect(things[0].value).to.equal(30);
      expect(things[0].metadata.unit).to.equal(unit);
    });

    it('can edit a thing', async () => {
      let type = 'beverage';
      let name = 'oat milk';
      let unit = '2 liters';
      [ proposal ] = await Things.createThingProposal(HOUSE, RESIDENT1, null, type, name, 20, { unit }, true, now);

      await Polls.submitVote(proposal.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(proposal.pollId, RESIDENT2, now, YAY);

      await Things.resolveThingProposal(proposal.id, proposalEnd);

      things = await Things.getThings(HOUSE);
      let thing = things.find(x => x.name === name);
      const initialThingId = thing.id;
      expect(thing.type).to.equal(type);
      expect(thing.name).to.equal(name);
      expect(thing.value).to.equal(20);
      expect(thing.metadata.unit).to.equal(unit);

      type = 'drinks';
      name = 'dairy alternatives';
      unit = '48 oz';
      [ proposal ] = await Things.createThingProposal(HOUSE, RESIDENT1, thing.id, type, name, 25, { unit }, true, now);

      await Polls.submitVote(proposal.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(proposal.pollId, RESIDENT2, now, YAY);

      await Things.resolveThingProposal(proposal.id, proposalEnd);

      things = await Things.getThings(HOUSE);
      thing = things.find(x => x.name === name);
      expect(thing.id).to.equal(initialThingId);
      expect(thing.type).to.equal(type);
      expect(thing.name).to.equal(name);
      expect(thing.value).to.equal(25);
      expect(thing.metadata.unit).to.equal(unit);
    });

    it('can delete a thing', async () => {
      [ proposal ] = await Things.createThingProposal(HOUSE, RESIDENT1, null, PANTRY, RICE, 20, {}, true, now);

      await Polls.submitVote(proposal.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(proposal.pollId, RESIDENT2, now, YAY);

      await Things.resolveThingProposal(proposal.id, proposalEnd);

      things = await Things.getThings(HOUSE);
      expect(things.length).to.equal(1);

      [ proposal ] = await Things.createThingProposal(HOUSE, RESIDENT1, things[0].id, PANTRY, RICE, 0, {}, false, now);

      await Polls.submitVote(proposal.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(proposal.pollId, RESIDENT2, now, YAY);

      await Things.resolveThingProposal(proposal.id, proposalEnd);

      things = await Things.getThings(HOUSE);
      expect(things.length).to.equal(0);
    });

    it('cannot create a proposal without either a thingId or type and name', async () => {
      await expect(Things.createThingProposal(HOUSE, RESIDENT1, null, PANTRY, null, 0, {}, true, now))
        .to.be.rejectedWith('Proposal must include either thingId or type and name!');

      await expect(Things.createThingProposal(HOUSE, RESIDENT1, null, null, RICE, 0, {}, true, now))
        .to.be.rejectedWith('Proposal must include either thingId or type and name!');
    });

    it('cannot resolve a proposal before the poll is closed', async () => {
      [ proposal ] = await Things.createThingProposal(HOUSE, RESIDENT1, null, PANTRY, RICE, 20, {}, true, now);

      await expect(Things.resolveThingProposal(proposal.id, soon))
        .to.be.rejectedWith('Poll not closed!');
    });

    it('cannot resolve a proposal twice', async () => {
      [ proposal ] = await Things.createThingProposal(HOUSE, RESIDENT1, null, PANTRY, RICE, 20, { }, true, now);

      await Things.resolveThingProposal(proposal.id, proposalEnd);

      await expect(Things.resolveThingProposal(proposal.id, proposalEnd))
        .to.be.rejectedWith('Proposal already resolved!');
    });

    it('can get the minimum votes for a proposal', async () => {
      let minVotes;

      // min: ceil( 4 residents * 40% ) = 2
      minVotes = await Things.getThingProposalMinVotes(HOUSE, now);
      expect(minVotes).to.equal(2);

      await Admin.deactivateResident(HOUSE, RESIDENT3, now);
      await Admin.deactivateResident(HOUSE, RESIDENT4, now);

      // min: ceil( 2 residents * 40% ) = 1
      minVotes = await Things.getThingProposalMinVotes(HOUSE, now);
      expect(minVotes).to.equal(1);
    });

    it('cannot approve a proposal with insufficient votes', async () => {
      things = await Things.getThings(HOUSE);
      expect(things.length).to.equal(0);

      [ proposal ] = await Things.createThingProposal(HOUSE, RESIDENT1, null, PANTRY, RICE, 20, {}, true, now);

      // 40% of 4 residents is 2 upvotes
      await Polls.submitVote(proposal.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(proposal.pollId, RESIDENT2, now, NAY);

      await Things.resolveThingProposal(proposal.id, proposalEnd);

      things = await Things.getThings(HOUSE);
      expect(things.length).to.equal(0);

      // Cannot resolve again
      await Polls.submitVote(proposal.pollId, RESIDENT3, now, YAY);
      await expect(Things.resolveThingProposal(proposal.id, proposalEnd))
        .to.be.rejectedWith('Proposal already resolved!');
    });

    it('can resolve proposals in bulk', async () => {
      things = await Things.getThings(HOUSE);
      expect(things.length).to.equal(0);

      const [ proposal1 ] = await Things.createThingProposal(HOUSE, RESIDENT1, null, 't1', 'n1', 0, {}, true, now);
      const [ proposal2 ] = await Things.createThingProposal(HOUSE, RESIDENT1, null, 't2', 'n2', 0, {}, true, now);

      await Polls.submitVote(proposal1.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(proposal1.pollId, RESIDENT2, now, YAY);

      await Polls.submitVote(proposal2.pollId, RESIDENT2, now, YAY);
      await Polls.submitVote(proposal2.pollId, RESIDENT1, now, YAY);

      // Not before the polls close
      await Things.resolveThingProposals(HOUSE, soon);
      things = await Things.getThings(HOUSE);
      expect(things.length).to.equal(0);

      // Actually resolve
      await Things.resolveThingProposals(HOUSE, proposalEnd);
      things = await Things.getThings(HOUSE);
      expect(things.length).to.equal(2);

      // But not twice
      await Things.resolveThingProposals(HOUSE, proposalEnd);
      things = await Things.getThings(HOUSE);
      expect(things.length).to.equal(2);
    });
  });
});
