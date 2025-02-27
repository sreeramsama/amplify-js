import { MutationEvent } from './index';
import { ModelPredicateCreator } from '../predicates';
import {
	ExclusiveStorage as Storage,
	StorageFacade,
	Storage as StorageClass,
} from '../storage/storage';
import { ModelInstanceCreator } from '../datastore/datastore';
import {
	InternalSchema,
	PersistentModel,
	PersistentModelConstructor,
	QueryOne,
	SchemaModel,
} from '../types';
import { USER, SYNC, valuesEqual } from '../util';
import { getIdentifierValue, TransformerMutationType } from './utils';

// TODO: Persist deleted ids
// https://github.com/aws-amplify/amplify-js/blob/datastore-docs/packages/datastore/docs/sync-engine.md#outbox
class MutationEventOutbox {
	private inProgressMutationEventId: string;

	constructor(
		private readonly schema: InternalSchema,
		private readonly MutationEvent: PersistentModelConstructor<MutationEvent>,
		private readonly modelInstanceCreator: ModelInstanceCreator,
		private readonly ownSymbol: Symbol
	) {}

	public async enqueue(
		storage: Storage,
		mutationEvent: MutationEvent
	): Promise<void> {
		storage.runExclusive(async s => {
			const mutationEventModelDefinition =
				this.schema.namespaces[SYNC].models['MutationEvent'];

			// `id` is the key for the record in the mutationEvent;
			// `modelId` is the key for the actual record that was mutated
			const predicate = ModelPredicateCreator.createFromExisting<MutationEvent>(
				mutationEventModelDefinition,
				c =>
					c
						.modelId('eq', mutationEvent.modelId)
						.id('ne', this.inProgressMutationEventId)
			);

			// Check if there are any other records with same id
			const [first] = await s.query(this.MutationEvent, predicate);

			// No other record with same modelId, so enqueue
			if (first === undefined) {
				await s.save(mutationEvent, undefined, this.ownSymbol);
				return;
			}

			// There was an enqueued mutation for the modelId, so continue
			const { operation: incomingMutationType } = mutationEvent;

			if (first.operation === TransformerMutationType.CREATE) {
				if (incomingMutationType === TransformerMutationType.DELETE) {
					await s.delete(this.MutationEvent, predicate);
				} else {
					// first gets updated with the incoming mutation's data, condition intentionally skipped

					// we need to merge the fields for a create and update mutation to prevent
					// data loss, since update mutations only include changed fields
					const merged = this.mergeUserFields(first, mutationEvent);
					await s.save(
						this.MutationEvent.copyOf(first, draft => {
							draft.data = merged.data;
						}),
						undefined,
						this.ownSymbol
					);
				}
			} else {
				const { condition: incomingConditionJSON } = mutationEvent;
				const incomingCondition = JSON.parse(incomingConditionJSON);
				let merged: MutationEvent;

				// If no condition
				if (Object.keys(incomingCondition).length === 0) {
					merged = this.mergeUserFields(first, mutationEvent);

					// delete all for model
					await s.delete(this.MutationEvent, predicate);
				}

				merged = merged || mutationEvent;

				// Enqueue new one
				await s.save(merged, undefined, this.ownSymbol);
			}
		});
	}

	public async dequeue(
		storage: StorageClass,
		record?: PersistentModel,
		recordOp?: TransformerMutationType
	): Promise<MutationEvent> {
		const head = await this.peek(storage);

		if (record) {
			await this.syncOutboxVersionsOnDequeue(storage, record, head, recordOp);
		}

		await storage.delete(head);
		this.inProgressMutationEventId = undefined;

		return head;
	}

	/**
	 * Doing a peek() implies that the mutation goes "inProgress"
	 *
	 * @param storage
	 */
	public async peek(storage: StorageFacade): Promise<MutationEvent> {
		const head = await storage.queryOne(this.MutationEvent, QueryOne.FIRST);

		this.inProgressMutationEventId = head ? head.id : undefined;

		return head;
	}

	public async getForModel<T extends PersistentModel>(
		storage: StorageFacade,
		model: T,
		userModelDefinition: SchemaModel
	): Promise<MutationEvent[]> {
		const mutationEventModelDefinition =
			this.schema.namespaces[SYNC].models.MutationEvent;

		const modelId = getIdentifierValue(userModelDefinition, model);

		const mutationEvents = await storage.query(
			this.MutationEvent,
			ModelPredicateCreator.createFromExisting(
				mutationEventModelDefinition,
				c => c.modelId('eq', modelId)
			)
		);

		return mutationEvents;
	}

	public async getModelIds(storage: StorageFacade): Promise<Set<string>> {
		const mutationEvents = await storage.query(this.MutationEvent);

		const result = new Set<string>();

		mutationEvents.forEach(({ modelId }) => result.add(modelId));

		return result;
	}

	// applies _version from the AppSync mutation response to other items
	// in the mutation queue with the same id
	// see https://github.com/aws-amplify/amplify-js/pull/7354 for more details
	private async syncOutboxVersionsOnDequeue(
		storage: StorageClass,
		record: PersistentModel,
		head: PersistentModel,
		recordOp: string
	): Promise<void> {
		if (head.operation !== recordOp) {
			return;
		}

		const { _version, _lastChangedAt, _deleted, ..._incomingData } = record;
		const incomingData = this.removeTimestampFields(head.model, _incomingData);

		const data = JSON.parse(head.data);

		if (!data) {
			return;
		}

		const {
			_version: __version,
			_lastChangedAt: __lastChangedAt,
			_deleted: __deleted,
			..._outgoingData
		} = data;
		const outgoingData = this.removeTimestampFields(head.model, _outgoingData);

		// Don't sync the version when the data in the response does not match the data
		// in the request, i.e., when there's a handled conflict
		if (!valuesEqual(incomingData, outgoingData, true)) {
			return;
		}

		const mutationEventModelDefinition =
			this.schema.namespaces[SYNC].models['MutationEvent'];

		const userModelDefinition =
			this.schema.namespaces['user'].models[head.model];

		const recordId = getIdentifierValue(userModelDefinition, record);

		const predicate = ModelPredicateCreator.createFromExisting<MutationEvent>(
			mutationEventModelDefinition,
			c => c.modelId('eq', recordId).id('ne', this.inProgressMutationEventId)
		);

		const outdatedMutations = await storage.query(
			this.MutationEvent,
			predicate
		);

		if (!outdatedMutations.length) {
			return;
		}

		const reconciledMutations = outdatedMutations.map(m => {
			const oldData = JSON.parse(m.data);

			const newData = { ...oldData, _version, _lastChangedAt };

			return this.MutationEvent.copyOf(m, draft => {
				draft.data = JSON.stringify(newData);
			});
		});

		await storage.delete(this.MutationEvent, predicate);

		await Promise.all(
			reconciledMutations.map(
				async m => await storage.save(m, undefined, this.ownSymbol)
			)
		);
	}

	private mergeUserFields(
		previous: MutationEvent,
		current: MutationEvent
	): MutationEvent {
		const { _version, _lastChangedAt, _deleted, ...previousData } = JSON.parse(
			previous.data
		);

		const {
			_version: __version,
			_lastChangedAt: __lastChangedAt,
			_deleted: __deleted,
			...currentData
		} = JSON.parse(current.data);

		const data = JSON.stringify({
			_version,
			_lastChangedAt,
			_deleted,
			...previousData,
			...currentData,
		});

		return this.modelInstanceCreator(this.MutationEvent, {
			...current,
			data,
		});
	}

	/* 
	if a model is using custom timestamp fields
	the custom field names will be stored in the model attributes

	e.g.
	"attributes": [
    {
			"type": "model",
			"properties": {
				"timestamps": {
					"createdAt": "createdOn",
					"updatedAt": "updatedOn"
				}
			}
    }
	]
	*/
	private removeTimestampFields(
		model: string,
		record: PersistentModel
	): PersistentModel {
		const CREATED_AT_DEFAULT_KEY = 'createdAt';
		const UPDATED_AT_DEFAULT_KEY = 'updatedAt';

		let createdTimestampKey = CREATED_AT_DEFAULT_KEY;
		let updatedTimestampKey = UPDATED_AT_DEFAULT_KEY;

		const modelAttributes = this.schema.namespaces[USER].models[
			model
		].attributes?.find(attr => attr.type === 'model');
		const timestampFieldsMap = modelAttributes?.properties?.timestamps;

		if (timestampFieldsMap) {
			createdTimestampKey = timestampFieldsMap[CREATED_AT_DEFAULT_KEY];
			updatedTimestampKey = timestampFieldsMap[UPDATED_AT_DEFAULT_KEY];
		}

		delete (record as Record<string, any>)[createdTimestampKey];
		delete (record as Record<string, any>)[updatedTimestampKey];

		return record;
	}
}

export { MutationEventOutbox };
