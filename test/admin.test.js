const { expect } = require('chai');
const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');

chai.use(chaiAsPromised);

const { Admin } = require('../src/core/index');
const { HOUR, DAY, CHORES_CONF, THINGS_CONF } = require('../src/constants');

const {
  getMonthStart,
  getMonthEnd,
  getNextMonthStart,
  getPrevMonthEnd,
  getDateStart,
  truncateHour,
} = require('../src/utils');

const testHelpers = require('./helpers');

describe('Admin', async () => {
  const HOUSE1 = testHelpers.generateSlackId();
  const HOUSE2 = testHelpers.generateSlackId();
  const RESIDENT1 = testHelpers.generateSlackId();
  const RESIDENT2 = testHelpers.generateSlackId();

  let now;
  let soon;

  beforeEach(async () => {
    now = new Date();
    soon = new Date(now.getTime() + HOUR);
  });

  afterEach(async () => {
    await testHelpers.resetDb();
  });

  describe('keeping track of houses', async () => {
    it('can add a house', async () => {
      let houses;

      houses = await Admin.getHouses();
      expect(houses.length).to.equal(0);

      await Admin.addHouse(HOUSE1);

      houses = await Admin.getHouses();
      expect(houses.length).to.equal(1);

      await Admin.addHouse(HOUSE2);

      houses = await Admin.getHouses();
      expect(houses.length).to.equal(2);
    });

    it('can add a house idempotently', async () => {
      let houses;
      houses = await Admin.getHouses();
      expect(houses.length).to.equal(0);

      await Admin.addHouse(HOUSE1);
      await Admin.addHouse(HOUSE2);

      houses = await Admin.getHouses();
      expect(houses.length).to.equal(2);

      await Admin.addHouse(HOUSE1);
      await Admin.addHouse(HOUSE2);

      houses = await Admin.getHouses();
      expect(houses.length).to.equal(2);
    });

    it('can update house info', async () => {
      await Admin.addHouse(HOUSE1, 'h1');

      const choresOauth = 'choresOauth';
      const thingsOauth = 'thingsOauth';
      const choresChannel = 'choresChannel';
      const thingsChannel = 'thingsChannel';

      await Admin.updateHouseConf(HOUSE1, CHORES_CONF, { channel: choresChannel, oauth: choresOauth });
      await Admin.updateHouseConf(HOUSE1, THINGS_CONF, { channel: thingsChannel, oauth: thingsOauth });

      let house;

      house = await Admin.getHouse(HOUSE1);
      expect(house.name).to.equal('h1');
      expect(house.choresConf.channel).to.equal(choresChannel);
      expect(house.choresConf.oauth).to.equal(choresOauth);
      expect(house.thingsConf.channel).to.equal(thingsChannel);
      expect(house.thingsConf.oauth).to.equal(thingsOauth);

      await Admin.updateHouseConf(HOUSE1, THINGS_CONF, { channel: null });

      house = await Admin.getHouse(HOUSE1);
      expect(house.choresConf.channel).to.equal(choresChannel);
      expect(house.choresConf.oauth).to.equal(choresOauth);
      expect(house.thingsConf.channel).to.be.null;
      expect(house.thingsConf.oauth).to.equal(thingsOauth);
    });
  });

  describe('keeping track of residents', async () => {
    beforeEach(async () => {
      await Admin.addHouse(HOUSE1);
      await Admin.addHouse(HOUSE2);
    });

    it('can activate a resident', async () => {
      let residents;
      residents = await Admin.getResidents(HOUSE1, now);
      expect(residents.length).to.equal(0);

      await Admin.activateResident(HOUSE1, RESIDENT1, now);

      residents = await Admin.getResidents(HOUSE1, now);
      expect(residents.length).to.equal(1);

      await Admin.activateResident(HOUSE1, RESIDENT2, now);

      residents = await Admin.getResidents(HOUSE1, now);
      expect(residents.length).to.equal(2);

      const resident1 = await Admin.getResident(RESIDENT1);
      expect(resident1.activeAt.getTime()).to.equal(truncateHour(now).getTime());
    });

    it('can activate a resident idempotently', async () => {
      let residents;
      residents = await Admin.getResidents(HOUSE1, now);
      expect(residents.length).to.equal(0);

      await Admin.activateResident(HOUSE1, RESIDENT1, now);
      await Admin.activateResident(HOUSE1, RESIDENT1, soon);

      residents = await Admin.getResidents(HOUSE1, now);
      expect(residents.length).to.equal(1);
      expect(residents[0].activeAt.getTime()).to.equal(truncateHour(now).getTime());
    });

    it('can deactivate a resident', async () => {
      await Admin.activateResident(HOUSE1, RESIDENT1, now);

      let residents;
      residents = await Admin.getResidents(HOUSE1, now);
      expect(residents.length).to.equal(1);

      await Admin.deactivateResident(HOUSE1, RESIDENT1);

      residents = await Admin.getResidents(HOUSE1, now);
      expect(residents.length).to.equal(0);

      const resident = await Admin.getResident(RESIDENT1);
      expect(resident.activeAt).to.equal(null);
    });

    it('can return inactive for a non-existent resident', async () => {
      const isActive = await Admin.isActive('', now);
      expect(isActive).to.be.undefined;
    });
  });

  describe('utility functions', async () => {
    it('can manipulate timestamps correctly', async () => {
      const feb1 = new Date(2022, 1, 1);
      const feb14 = new Date(2022, 1, 14);
      const feb28 = new Date(2022, 1, 28);
      const mar1 = new Date(2022, 2, 1);
      const mar15 = new Date(2022, 2, 15);
      const mar31 = new Date(2022, 2, 31);

      expect(getMonthStart(feb1).getTime()).to.equal(feb1.getTime());
      expect(getMonthStart(feb14).getTime()).to.equal(feb1.getTime());
      expect(getMonthStart(feb28).getTime()).to.equal(feb1.getTime());
      expect(getMonthStart(mar1).getTime()).to.equal(mar1.getTime());
      expect(getMonthStart(mar15).getTime()).to.equal(mar1.getTime());
      expect(getMonthStart(mar31).getTime()).to.equal(mar1.getTime());

      expect(getMonthEnd(feb1).getTime()).to.equal(feb28.getTime() + DAY - 1);
      expect(getMonthEnd(feb14).getTime()).to.equal(feb28.getTime() + DAY - 1);
      expect(getMonthEnd(feb28).getTime()).to.equal(feb28.getTime() + DAY - 1);
      expect(getMonthEnd(mar1).getTime()).to.equal(mar31.getTime() + DAY - 1);
      expect(getMonthEnd(mar15).getTime()).to.equal(mar31.getTime() + DAY - 1);
      expect(getMonthEnd(mar31).getTime()).to.equal(mar31.getTime() + DAY - 1);

      expect(getPrevMonthEnd(mar1).getTime()).to.equal(feb28.getTime() + DAY - 1);
      expect(getPrevMonthEnd(mar15).getTime()).to.equal(feb28.getTime() + DAY - 1);
      expect(getPrevMonthEnd(mar31).getTime()).to.equal(feb28.getTime() + DAY - 1);

      expect(getMonthEnd(feb1).getTime()).to.equal(getMonthStart(mar1).getTime() - 1);
      expect(getMonthEnd(feb28).getTime()).to.equal(getMonthStart(mar31).getTime() - 1);

      expect(getNextMonthStart(feb1).getTime()).to.equal(mar1.getTime());
      expect(getNextMonthStart(feb14).getTime()).to.equal(mar1.getTime());
      expect(getNextMonthStart(feb28).getTime()).to.equal(mar1.getTime());

      expect(getDateStart(now).getHours()).to.equal(0);
      expect(getDateStart(now).getMinutes()).to.equal(0);
      expect(getDateStart(now).getSeconds()).to.equal(0);
    });
  });
});
