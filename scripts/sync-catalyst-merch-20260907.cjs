// Run inside an existing app container: --apply /tmp/catalog-before.json. Default: read-only.
/* global require, process, console, URL */
/* eslint @typescript-eslint/no-require-imports: off -- this operator script runs in the existing CommonJS bot container */
const { Client } = require('pg');
const { writeFileSync } = require('node:fs');
const catalog = require('./catalog/catalyst-20260907.json');
const release = 'catalyst-merch-20260907-v1';
const apply = process.argv[2] === '--apply';
const origin = process.env.WEB_ORIGIN || process.env.WEB_APP_URL;
const pickup =
  'После оплаты оставьте заявку на выдачу в разделе «Мои заявки». Заявки обрабатываются в порядке живой очереди; дождитесь подтверждения организаторов.';
(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query('begin');
    await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [release]);
    const before = {
      products: (await db.query('select * from store_products order by id for update')).rows,
      inventory: (
        await db.query('select * from store_product_inventory order by product_id for update')
      ).rows,
      media: (await db.query('select * from store_product_media order by product_id,sort_order'))
        .rows,
    };
    const completed = await db.query('select id from audit_logs where action=$1 and entity_id=$2', [
      'store.catalog.publish',
      release,
    ]);
    if (completed.rowCount) {
      console.log('Already applied; no changes.');
      await db.query('rollback');
      return;
    }
    for (const item of catalog) {
      const collision = before.products.find(
        (p) =>
          p.title.toLowerCase() === item.title.toLowerCase() &&
          p.slug !== item.slug &&
          !p.deleted_at,
      );
      if (collision) throw new Error('Resolve existing product before import: ' + collision.slug);
      if (before.products.some((p) => p.slug === item.slug && p.deleted_at))
        throw new Error('Refusing to revive deleted product: ' + item.slug);
    }
    console.log(
      JSON.stringify({
        mode: apply ? 'apply' : 'dry-run',
        existing: before.products.map((p) => ({ slug: p.slug, price: p.price, status: p.status })),
        planned: catalog.map((p) => ({
          slug: p.slug,
          price: p.price,
          initialStock: p.stock,
          preserveExistingInventory: true,
        })),
      }),
    );
    if (!apply) {
      await db.query('rollback');
      return;
    }
    if (!origin || new URL(origin).protocol !== 'https:')
      throw new Error('HTTPS WEB_ORIGIN or WEB_APP_URL required');
    if (!process.argv[3]) throw new Error('Backup path required');
    writeFileSync(process.argv[3], JSON.stringify(before, null, 2), { flag: 'wx', mode: 0o600 });
    for (const [index, item] of catalog.entries()) {
      let category = (
        await db.query(
          'select id from store_categories where lower(title)=lower($1) and deleted_at is null limit 1',
          [item.category],
        )
      ).rows[0];
      if (!category)
        category = (
          await db.query('insert into store_categories(slug,title) values($1,$2) returning id', [
            item.category === 'Мерч' ? 'catalyst-merch' : 'catalyst-opportunities',
            item.category,
          ])
        ).rows[0];
      const old = before.products.find((p) => p.slug === item.slug);
      const cover = item.files[0] ? new URL('/merch/' + item.files[0], origin).href : null;
      const params = [
        category.id,
        item.slug,
        item.title,
        item.description,
        item.price,
        cover,
        index,
        item.slug === 'catalyst-startup-lynch-pass' ? null : pickup,
      ];
      const product = (
        await db.query(
          `insert into store_products(category_id,slug,title,description,price,cover_url,sort_order,pickup_instructions,status,kind,stock_mode)
        values($1,$2,$3,$4,$5,$6,$7,$8,'published','physical','limited')
        on conflict(slug) do update set category_id=excluded.category_id,title=excluded.title,description=excluded.description,description_format='text',
        price=excluded.price,cover_url=excluded.cover_url,sort_order=excluded.sort_order,pickup_instructions=excluded.pickup_instructions,
        card_html=null,card_package_id=null,status='published',updated_at=now() returning id`,
          params,
        )
      ).rows[0];
      // Only initialise NEW inventory. Never reset sold/reserved stock or invent unknown quantities.
      const stock = old ? 0 : (item.stock ?? 0);
      const inserted = await db.query(
        'insert into store_product_inventory(product_id,on_hand) values($1,$2) on conflict(product_id) do nothing returning product_id',
        [product.id, stock],
      );
      if (inserted.rowCount && stock > 0)
        await db.query(
          `insert into inventory_movements(product_id,kind,quantity,on_hand_after,reserved_after,idempotency_key,reason)
        values($1,'restock',$2,$2,0,$3,$4)`,
          [
            product.id,
            stock,
            release + ':' + item.slug,
            'Initial stock explicitly supplied by owner: 50 per accelerator',
          ],
        );
      for (const [mediaIndex, file] of item.files.entries()) {
        const url = new URL('/merch/' + file, origin).href;
        await db.query(
          `insert into store_product_media(product_id,url,alt_text,sort_order)
          select $1,$2,$3,$4 where not exists(select 1 from store_product_media where product_id=$1 and url=$2)`,
          [product.id, url, item.title, mediaIndex],
        );
      }
      await db.query(
        'insert into audit_logs(action,entity_type,entity_id,metadata) values($1,$2,$3,$4)',
        [
          'store.product.catalog_update',
          'store_product',
          product.id,
          JSON.stringify({
            release,
            authority: 'explicit_user_request',
            previous: old ?? null,
            price: item.price,
            stockPreserved: !!old,
            initialStock: old ? null : stock,
          }),
        ],
      );
    }
    await db.query(
      'insert into audit_logs(action,entity_type,entity_id,metadata) values($1,$2,$3,$4)',
      [
        'store.catalog.publish',
        'store_catalog',
        release,
        JSON.stringify({
          authority: 'explicit_user_request',
          products: catalog.map((p) => p.slug),
          backup: process.argv[3],
        }),
      ],
    );
    await db.query('commit');
    console.log(
      JSON.stringify(
        (
          await db.query(
            'select p.slug,p.price,p.status,i.on_hand,i.reserved from store_products p left join store_product_inventory i on i.product_id=p.id where p.slug=any($1) order by p.sort_order',
            [catalog.map((p) => p.slug)],
          )
        ).rows,
      ),
    );
  } catch (error) {
    await db.query('rollback');
    throw error;
  } finally {
    await db.end();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
