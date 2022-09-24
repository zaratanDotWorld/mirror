exports.up = function(knex, Promise) {
    return knex.schema.createTable('Poll', function(t) {
        t.increments('id').unsigned().primary();
        t.timestamps(useTimestamps = true, defaultToNow = true, useCamelCase = true);
        t.timestamp('startTime').notNull();
        t.timestamp('endTime').notNull();
    });
};

exports.down = function(knex, Promise) {
    return knex.schema.dropTable('Poll');
};