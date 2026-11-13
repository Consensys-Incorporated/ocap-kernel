import { makeScalarMapStore, makeScalarSetStore } from '@agoric/store';
import { makeExo, defineExoClass, defineExoClassKit } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeDefaultExo } from '@metamask/kernel-utils/exo';
import type { Baggage } from '@metamask/ocap-kernel';

import { unwrapTestLogger } from '../test-powers.ts';
import type { TestPowers } from '../test-powers.ts';

/**
 * Build function for testing exo objects and liveslots virtual object functionality.
 *
 * @param vatPowers - Special powers granted to this vat.
 * @param vatPowers.logger - The logger for the vat.
 * @param parameters - Initialization parameters from the vat's config object.
 * @param parameters.name - The name of the vat.
 * @param baggage - Root of vat's persistent state.
 * @returns The root object for the new vat.
 */
// oxlint-disable-next-line typescript/explicit-function-return-type
export function buildRootObject(
  vatPowers: TestPowers,
  parameters: { name?: string },
  baggage: Baggage,
) {
  const vatName = parameters?.name ?? 'anonymous';
  const tlog = unwrapTestLogger(vatPowers, vatName);

  /**
   * Print a message to the log.
   *
   * @param message - The message to print.
   */
  function log(message: string): void {
    // oxlint-disable-next-line no-console
    console.log(`${vatName}: ${message}`);
  }

  log(`buildRootObject`);

  // Create stores for testing
  const mapStore = makeScalarMapStore<string, unknown>('testMap');
  const setStore = makeScalarSetStore<unknown>('testSet');

  // Define interfaces for our Exo objects
  const CounterI = M.interface('Counter', {
    getValue: M.call().returns(M.number()),
    increment: M.call(M.number()).returns(M.number()),
    decrement: M.call(M.number()).returns(M.number()),
  });

  const PersonI = M.interface('Person', {
    getName: M.call().returns(M.string()),
    getAge: M.call().returns(M.number()),
    birthday: M.call().returns(M.number()),
    addFriend: M.call(M.any()).returns(M.number()),
    getFriends: M.call().returns(M.arrayOf(M.any())),
  });

  // Define two facets for a Temperature converter
  const CelsiusI = M.interface('Celsius', {
    getCelsius: M.call().returns(M.number()),
    setCelsius: M.call(M.number()).returns(M.number()),
  });

  const FahrenheitI = M.interface('Fahrenheit', {
    getFahrenheit: M.call().returns(M.number()),
    setFahrenheit: M.call(M.number()).returns(M.number()),
  });

  // Define a simple Counter exo class
  const Counter = defineExoClass(
    'Counter',
    CounterI,
    (initialValue = 0) => ({ value: initialValue }),
    {
      getValue() {
        return this.state.value;
      },
      increment(amount = 1) {
        this.state.value += amount;
        return this.state.value;
      },
      decrement(amount = 1) {
        this.state.value -= amount;
        return this.state.value;
      },
    },
  );

  // Define a Person exo class with more complex state
  const Person = defineExoClass(
    'Person',
    PersonI,
    (name: string, age: number) => ({ name, age, friends: [] as unknown[] }),
    {
      getName() {
        return this.state.name;
      },
      getAge() {
        return this.state.age;
      },
      birthday() {
        this.state.age += 1;
        return this.state.age;
      },
      addFriend(friend: unknown) {
        this.state.friends.push(friend);
        return this.state.friends.length;
      },
      getFriends() {
        return [...this.state.friends];
      },
    },
  );

  // Use defineExoClassKit to create a Temperature converter with two facets
  const makeTemperatureKit = defineExoClassKit(
    'Temperature',
    { celsius: CelsiusI, fahrenheit: FahrenheitI },
    (initialCelsius = 0) => ({ celsius: initialCelsius }),
    {
      celsius: {
        getCelsius() {
          return this.state.celsius;
        },
        setCelsius(value: number) {
          this.state.celsius = value;
          return value;
        },
      },
      fahrenheit: {
        getFahrenheit() {
          return (this.state.celsius * 9) / 5 + 32;
        },
        setFahrenheit(value: number) {
          this.state.celsius = ((value - 32) * 5) / 9;
          return value;
        },
      },
    },
  );

  // Initialize state if not present
  if (baggage.has('initialized')) {
    tlog(`state already initialized`);
  } else {
    baggage.init('initialized', true);
    baggage.init('counterValue', 0);
    tlog(`initializing state`);
  }

  // Create a counter instance stored in baggage
  let counterValue = baggage.get('counterValue') as number;
  tlog(`counter value from baggage: ${counterValue}`);

  // Create a direct exo instance using makeExo
  const simpleCounter = makeExo('SimpleCounter', CounterI, {
    getValue() {
      return counterValue;
    },
    increment(amount = 1) {
      counterValue += amount;
      return counterValue;
    },
    decrement(amount = 1) {
      counterValue -= amount;
      return counterValue;
    },
  });

  return makeDefaultExo('root', {
    async bootstrap() {
      tlog(`bootstrap()`);

      // Test Counter from defineExoClass
      const counter = Counter(10);
      tlog(`Created counter with initial value: ${counter.getValue()}`);
      const newVal = counter.increment(5);
      tlog(`Incremented counter by 5 to: ${newVal}`);

      try {
        counter.increment(-3); // Should fail due to type constraints
        tlog(`ERROR: Increment with negative value should have failed`);
      } catch (error) {
        tlog(
          `Successfully caught error on negative increment: ${(error as Error).message}`,
        );
      }

      // Test Person from defineExoClass
      const alice = Person('Alice', 30);
      const bob = Person('Bob', 25);
      alice.addFriend(bob);
      tlog(`${alice.getName()} has ${alice.getFriends().length} friends`);

      // Test map store
      mapStore.init('alice', alice);
      mapStore.init('bob', bob);
      tlog(`Added ${mapStore.getSize()} entries to map store`);

      // Test set store
      setStore.add(alice);
      setStore.add(bob);
      tlog(`Added ${setStore.getSize()} entries to set store`);

      // Test retrieving from stores
      const retrievedAlice = mapStore.get('alice') as {
        getName: () => string;
      };
      tlog(`Retrieved ${retrievedAlice.getName()} from map store`);

      // Test Temperature from defineExoClassKit
      const { celsius, fahrenheit } = makeTemperatureKit(25);
      tlog(`Temperature at 25°C = ${fahrenheit.getFahrenheit()}°F`);

      fahrenheit.setFahrenheit(68);
      tlog(`After setting to 68°F, celsius is ${celsius.getCelsius()}°C`);

      // Test direct exo object with makeExo
      tlog(`SimpleCounter initial value: ${simpleCounter.getValue()}`);
      const simpleIncremented = simpleCounter.increment(7);
      tlog(`SimpleCounter after +7: ${simpleIncremented}`);

      // Test persistence
      counterValue = simpleCounter.getValue();
      baggage.set('counterValue', counterValue);
      tlog(`Updated baggage counter to: ${counterValue}`);

      return 'exo-test-complete';
    },

    createCounter(initialValue = 0) {
      const counter = Counter(initialValue);
      tlog(`Created new counter with value: ${initialValue}`);
      return counter;
    },

    createPerson(name: string, age: number) {
      const person = Person(name, age);
      tlog(`Created person ${name}, age ${age}`);
      return person;
    },

    createTemperature(initialCelsius = 0) {
      const temperature = makeTemperatureKit(initialCelsius);
      tlog(`Created temperature converter starting at ${initialCelsius}°C`);
      return temperature;
    },

    createOrUpdateInMap(key: string, value: unknown) {
      if (mapStore.has(key)) {
        mapStore.set(key, value);
        tlog(`Updated ${key} in map`);
      } else {
        mapStore.init(key, value);
        tlog(`Added ${key} to map, size now: ${mapStore.getSize()}`);
      }
      return mapStore.getSize();
    },

    getFromMap(key: string) {
      if (mapStore.has(key)) {
        tlog(`Found ${key} in map`);
        return mapStore.get(key);
      }
      tlog(`${key} not found in map`);
      return null;
    },

    testExoClass() {
      const counter = Counter(3);
      let result = counter.increment(5);
      tlog(`Counter: 3 + 5 = ${result}`);

      result = counter.decrement(2);
      tlog(`Counter: 8 - 2 = ${result}`);

      try {
        // Intentionally passing a string to test validation
        counter.increment('foo');
        tlog(`ERROR: Increment with string should have failed`);
      } catch (error) {
        tlog(`Successfully caught type error: ${(error as Error).message}`);
      }

      return 'exoClass-tests-complete';
    },

    testExoClassKit() {
      const { celsius, fahrenheit } = makeTemperatureKit(20);

      tlog(`20°C = ${fahrenheit.getFahrenheit()}°F`);

      fahrenheit.setFahrenheit(32);
      tlog(`32°F = ${celsius.getCelsius()}°C`);

      // Access between facets should not work
      try {
        // @ts-expect-error Testing for expected runtime failure
        celsius.getFahrenheit();
        tlog(`ERROR: Cross-facet access should have failed`);
      } catch (error) {
        tlog(
          `Successfully caught cross-facet error: ${(error as Error).message}`,
        );
      }

      return 'exoClassKit-tests-complete';
    },

    testScalarStore() {
      // Test map store operations
      const person = Person('Charlie', 40);
      mapStore.init('charlie', person);
      tlog(`Map store size: ${mapStore.getSize()}`);
      tlog(`Map store keys: ${[...mapStore.keys()].join(', ')}`);
      tlog(`Map has 'charlie': ${mapStore.has('charlie')}`);

      // Test set store operations
      setStore.add(person);
      tlog(`Set store size: ${setStore.getSize()}`);
      tlog(`Set has Charlie: ${setStore.has(person)}`);

      return 'scalar-store-tests-complete';
    },
  });
}
