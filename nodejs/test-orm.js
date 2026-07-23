const { init } = require('@simpleworkjs/orm');
const { Resource, ResourceEdge, ResourceGroup } = require('./models/resource');

async function test() {
  try {
    const models = await init({
      conf: {
        orm: {
          dialect: 'sqlite',
          storage: ':memory:', // Test in memory
          logging: false
        }
      },
      models: [Resource, ResourceEdge, ResourceGroup]
    });

    console.log('ORM initialized successfully!');
    
    const r1 = await models.Resource.create({
      kind: 'proxmox_node',
      name: 'pve1',
      slug: 'pve1',
      metadata: { ip: '10.0.0.1' }
    });
    
    const r2 = await models.Resource.create({
      kind: 'container',
      name: 'ct101',
      slug: 'ct101',
      metadata: { ip: '10.0.0.2' }
    });

    await models.ResourceEdge.create({
      parentId: r1.id,
      childId: r2.id,
      relation: 'hosts'
    });

    const edges = await models.ResourceEdge.list();
    console.log('Edges:', JSON.stringify(edges, null, 2));
    
  } catch (err) {
    console.error('Failed:', err);
  }
}

test();
