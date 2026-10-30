import { Entity, Column, PrimaryColumn, Generated } from 'typeorm';

@Entity('app_user')
export class User {
  @PrimaryColumn({
    type: 'bigint',
    transformer: {
      to: (value) => value,
      from: (value) => {
        const result = Number(value);
        if (!Number.isSafeInteger(result))
          throw new Error('Database ID exceeds JavaScript safe integer range');
        return result;
      },
    },
  })
  @Generated('increment')
  id: number;

  @Column({ type: 'varchar', length: 255, nullable: false, unique: true })
  username: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  password: string;

  @Column({ type: 'datetime', precision: 6, nullable: true, name: 'created_at' })
  createdAt: Date | null;
}
