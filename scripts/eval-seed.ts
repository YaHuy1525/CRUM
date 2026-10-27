// scripts/eval-seed.ts
import { createCrumMastra } from '../src/mastra/index'
import { parseEnv } from '../src/config/env'
import { getGoldenItems } from '../src/evals/golden-items'

const DATASET_ID = 'crum-golden'
const DATASET_VERSION = 'golden-v1'

async function main() {
  const env = parseEnv()
  const mastra = createCrumMastra(env)
  const items = getGoldenItems()

  console.log(`Seeding ${items.length} golden items...`)

  // Create or retrieve the dataset via the Mastra datasets domain.
  // The dataset is version-pinned to golden-v1 so experiments can reference
  // a stable snapshot even as items are added in later revisions.
  let dataset
  try {
    dataset = await mastra.datasets.get({ id: DATASET_ID })
    console.log(`Dataset '${DATASET_ID}' already exists.`)
  } catch {
    dataset = await mastra.datasets.create({
      id: DATASET_ID,
      name: 'CRUM Golden Dataset',
      description: `40-item golden dataset for CRUM eval gate. Version: ${DATASET_VERSION}`,
      requestContextSchema: null,
      metadata: { version: DATASET_VERSION },
    })
    console.log(`Created dataset '${DATASET_ID}' (version ${DATASET_VERSION}).`)
  }

  // Add each item with unmockedToolPolicy: 'deny' so experiment runs block
  // any tool call not covered by the item's toolMocks (fail-closed). §7.4.
  for (const item of items) {
    await dataset.addItem({
      input: item.input,
      groundTruth: item.groundTruth,
      toolMocks: item.toolMocks,
      unmockedToolPolicy: 'deny',
      metadata: { category: item.category },
    })
  }

  console.log(`Seeded ${items.length} items into '${DATASET_ID}' dataset (version ${DATASET_VERSION}).`)
  process.exit(0)
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
