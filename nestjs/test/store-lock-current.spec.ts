import { MysqlStore } from "../src/persistence/mysql.store";
it("行锁返回当前已提交的数据，不再通过一致性读取返回事务旧快照", async () => {
  const columns = [
    { propertyName: "id", databaseName: "id", type: "bigint" },
    { propertyName: "score", databaseName: "score", type: "double" },
  ];
  const metadata = {
    tableName: "quiz_attempts",
    columns,
    findColumnWithPropertyName: (key: string) => columns.find((c) => c.propertyName === key),
  };
  const manager: any = {
    queryRunner: {
      isTransactionActive: true,
      query: async (sql: string) =>
        sql.startsWith("SET ")
          ? []
          : sql.includes("FOR UPDATE")
            ? [{ id: "1", score: 100 }]
            : [{ id: "1", score: 0 }],
    },
    connection: { options: { timezone: "+08:00" }, getMetadata: () => metadata },
  };
  const row = await new MysqlStore(manager).lock("quizAttempts", 1);
  expect(row?.score).toBe(100);
  expect(row?.id).toBe(1);
});
