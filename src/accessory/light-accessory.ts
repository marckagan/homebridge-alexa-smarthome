import * as A from 'fp-ts/Array';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { constant, constVoid, flow, identity, pipe } from 'fp-ts/lib/function';
import { CharacteristicValue, Service } from 'homebridge';
import { match } from 'ts-pattern';
import { SupportedActionsType } from '../domain/alexa';
import { LightbulbState } from '../domain/alexa/lightbulb';
import * as lightMapper from '../mapper/light-mapper';
import * as mapper from '../mapper/power-mapper';
import { withRetry } from '../util/fp-util';
import { AlexaApiWrapper } from '../wrapper/alexa-api-wrapper';
import BaseAccessory from './base-accessory';

export default class LightAccessory extends BaseAccessory {
  static requiredOperations: SupportedActionsType[] = ['turnOn', 'turnOff'];
  service: Service;
  isExternalAccessory = false;

  configureServices() {
    this.service =
      this.platformAcc.getService(this.Service.Lightbulb) ||
      this.platformAcc.addService(
        this.Service.Lightbulb,
        this.device.displayName,
      );

    this.service
      .getCharacteristic(this.Characteristic.On)
      .onGet(this.handlePowerGet.bind(this))
      .onSet(this.handlePowerSet.bind(this));

    if (this.device.supportedOperations.includes('setBrightness')) {
      this.service
        .getCharacteristic(this.Characteristic.Brightness)
        .onGet(this.handleBrightnessGet.bind(this))
        .onSet(this.handleBrightnessSet.bind(this));
    } else {
      this.removeCharacteristic(this.Characteristic.Brightness);
    }

    if (this.device.supportedOperations.includes('setColor')) {
      this.service
        .getCharacteristic(this.Characteristic.Hue)
        .onGet(this.handleHueGet.bind(this))
        .onSet(this.handleHueSet.bind(this));
      this.service
        .getCharacteristic(this.Characteristic.Saturation)
        .onGet(this.handleSaturationGet.bind(this))
        .onSet(constVoid);
    } else {
      this.removeCharacteristic(this.Characteristic.Hue);
      this.removeCharacteristic(this.Characteristic.Saturation);
    }

    if (this.device.supportedOperations.includes('setColorTemperature')) {
      this.service
        .getCharacteristic(this.Characteristic.ColorTemperature)
        .onGet(this.handleColorTemperatureGet.bind(this))
        .onSet(this.handleColorTemperatureSet.bind(this));
    } else {
      this.removeCharacteristic(this.Characteristic.ColorTemperature);
    }
  }

  async handlePowerGet(): Promise<boolean> {
    const determinePowerState = flow(
      A.findFirst<LightbulbState>(({ featureName }) => featureName === 'power'),
      O.tap(({ value }) =>
        O.of(this.logWithContext('debug', `Get power result: ${value}`)),
      ),
      O.map(({ value }) => value === 'ON'),
    );

    return pipe(
      this.getStateGraphQl(determinePowerState),
      TE.match((e) => {
        this.logWithContext('errorT', 'Get power', e);
        throw this.serviceCommunicationError;
      }, identity),
    )();
  }

  async handlePowerSet(value: CharacteristicValue): Promise<void> {
    this.logWithContext('debug', `Triggered set power: ${value}`);
    if (typeof value !== 'boolean') {
      throw this.invalidValueError;
    }
    const action = mapper.mapHomeKitPowerToAlexaAction(value);
    return pipe(
      this.platform.alexaApi.setDeviceStateGraphQl(
        this.device.endpointId,
        'power',
        action,
      ),
      TE.match(
        (e) => {
          this.logWithContext('errorT', 'Set power', e);
          throw this.serviceCommunicationError;
        },
        () => {
          this.updateCacheValue({
            value: mapper.mapHomeKitPowerToAlexaValue(value),
            featureName: 'power',
          });
        },
      ),
    )();
  }

  async handleBrightnessGet(): Promise<number> {
    const determineBrightnessState = flow(
      A.findFirst<LightbulbState>(
        ({ featureName }) => featureName === 'brightness',
      ),
      O.flatMap(({ value }) =>
        typeof value === 'number' ? O.of(value) : O.none,
      ),
      O.tap((s) =>
        O.of(this.logWithContext('debug', `Get brightness result: ${s}`)),
      ),
    );

    return pipe(
      this.getStateGraphQl(determineBrightnessState),
      TE.match((e) => {
        this.logWithContext('errorT', 'Get brightness', e);
        throw this.serviceCommunicationError;
      }, identity),
    )();
  }

  async handleBrightnessSet(value: CharacteristicValue): Promise<void> {
    this.logWithContext('debug', `Triggered set brightness: ${value}`);
    if (typeof value !== 'number') {
      throw this.invalidValueError;
    }
    const attemptSet = () =>
      this.platform.alexaApi.setDeviceStateGraphQl(
        this.device.endpointId,
        'brightness',
        'setBrightness',
        {
          // Must be a number, not a string: a live capture of the Alexa
          // website's own setBrightness mutation confirmed its payload is
          // `{"brightness": 95}` (an int), not `{"brightness": "95"}`.
          // Sending a stringified value here is what caused every single
          // brightness set to fail with a generic INTERNAL_ERROR (a type
          // mismatch reaching Alexa's resolver, not a device/network
          // issue) - confirmed live: power sets (no numeric payload)
          // worked fine the whole time, only brightness failed, 100% of
          // attempts, regardless of device connectivity.
          brightness: value,
        },
      );

    // The Alexa app/website reflect a brightness change within 1-2 seconds
    // (confirmed against real usage), but a single attempt against this
    // same backend was observed taking up to ~9 seconds before even
    // failing - which only makes sense if the app is updating its UI
    // optimistically rather than waiting on full device-delivery
    // confirmation. Mirror that: update HomeKit's value immediately, then
    // confirm/retry against the real API in the background. Blocking this
    // call on however long the full round trip takes is what produced a
    // stuck "Updating" state in the Home app (confirmed live).
    this.updateCacheValue({
      // Cache the numeric value, not the stringified `newBrightness` sent
      // in the API request body - handleBrightnessGet's parser only
      // accepts `typeof value === 'number'`, matching how a live Alexa
      // response represents it, so caching the string form here would
      // silently fail that check on the next Get.
      value,
      featureName: 'brightness',
    });

    withRetry(attemptSet(), {
      retries: 2,
      delayMs: 3000,
      shouldRetry: AlexaApiWrapper.isRetryableDeviceError,
    })().then((result) => {
      if (result._tag === 'Left') {
        this.logWithContext('errorT', 'Set brightness', result.left);
      }
    });
  }

  async handleHueGet(): Promise<number> {
    const determineHueState = (states: LightbulbState[]) =>
      pipe(
        states,
        A.findFirst<LightbulbState>(
          ({ featureName }) => featureName === 'color',
        ),
        O.flatMap(({ value }) => {
          if (typeof value !== 'object' || typeof value.hue !== 'number') {
            return O.none;
          }
          return O.of(Math.trunc(value.hue));
        }),
        O.tap((s) =>
          O.of(this.logWithContext('debug', `Get hue result: ${s}`)),
        ),
        O.orElse(() => this.fallbackColorValue(states, 'hue')),
      );

    return pipe(
      this.getStateGraphQl(determineHueState),
      TE.match((e) => {
        this.logWithContext('errorT', 'Get hue', e);
        throw this.serviceCommunicationError;
      }, identity),
    )();
  }

  async handleHueSet(value: CharacteristicValue): Promise<void> {
    this.logWithContext('debug', `Triggered set hue: ${value}`);
    if (typeof value !== 'number') {
      throw this.invalidValueError;
    }
    const newColorName = lightMapper.mapHomeKitHueToAlexaValue(value);

    return pipe(
      newColorName,
      TE.fromOption(() => this.invalidValueError),
      TE.flatMap((colorName) =>
        this.platform.alexaApi.setDeviceState(this.device.id, 'setColor', {
          colorName,
        }),
      ),
      TE.match(
        (e) => {
          this.logWithContext('errorT', 'Set hue', e);
          throw this.serviceCommunicationError;
        },
        () => {
          pipe(
            this.getCacheValue('color'),
            O.filter(
              (
                color,
              ): color is {
                brightness: number;
                hue: number;
                saturation: number;
              } =>
                typeof color === 'object' &&
                color !== null &&
                typeof color.brightness === 'number' &&
                typeof color.hue === 'number' &&
                typeof color.saturation === 'number',
            ),
            O.map((color) =>
              this.updateCacheValue({
                value: {
                  ...color,
                  hue: value,
                },
                featureName: 'color',
              }),
            ),
          );
        },
      ),
    )();
  }

  async handleSaturationGet(): Promise<number> {
    const determineSaturationState = (states: LightbulbState[]) =>
      pipe(
        states,
        A.findFirst<LightbulbState>(
          ({ featureName }) => featureName === 'color',
        ),
        O.flatMap(({ value }) => {
          if (
            typeof value !== 'object' ||
            typeof value.saturation !== 'number'
          ) {
            return O.none;
          }
          // Alexa usually reports saturation as a 0-1 fraction, but has
          // been observed returning it already as a 0-100 percentage.
          // Detect which scale we got and clamp to a valid 0-100 range.
          const asPercent =
            value.saturation <= 1 ? value.saturation * 100 : value.saturation;
          return O.of(Math.min(100, Math.max(0, Math.trunc(asPercent))));
        }),
        O.tap((s) =>
          O.of(this.logWithContext('debug', `Get saturation result: ${s}%`)),
        ),
        O.orElse(() => this.fallbackColorValue(states, 'saturation')),
      );

    return pipe(
      this.getStateGraphQl(determineSaturationState),
      TE.match((e) => {
        this.logWithContext('errorT', 'Get saturation', e);
        throw this.serviceCommunicationError;
      }, identity),
    )();
  }

  async handleColorTemperatureGet(): Promise<number> {
    const determineColorTemperatureState = flow(
      A.findFirst<LightbulbState>(
        ({ featureName }) => featureName === 'colorTemperature',
      ),
      O.tap(({ value }) =>
        O.of(
          this.logWithContext(
            'debug',
            `Get color temperature result: ${value} K`,
          ),
        ),
      ),
      O.flatMap(({ value }) => {
        if (typeof value !== 'number') {
          return O.none;
        }
        // Clamp the color temperature to a valid range (140 - 500)
        return O.of(
          match(1_000_000 / value)
            .when((_) => _ < 140, constant(140))
            .when((_) => _ > 500, constant(500))
            .otherwise(identity),
        );
      }),
    );

    return pipe(
      this.getStateGraphQl(determineColorTemperatureState),
      TE.match((e) => {
        this.logWithContext('errorT', 'Get color temperature', e);
        throw this.serviceCommunicationError;
      }, identity),
    )();
  }

  async handleColorTemperatureSet(value: CharacteristicValue): Promise<void> {
    this.logWithContext('debug', `Triggered set color temperature: ${value}`);
    if (typeof value !== 'number') {
      throw this.invalidValueError;
    }
    const colorTemperatureInKelvin = 1_000_000 / value;
    return pipe(
      this.platform.alexaApi.setDeviceStateGraphQl(
        this.device.endpointId,
        'colorTemperature',
        'setColorTemperature',
        {
          colorTemperatureInKelvin,
        },
      ),
      TE.match(
        (e) => {
          this.logWithContext('errorT', 'Set color temperature', e);
          throw this.serviceCommunicationError;
        },
        () => {
          this.updateCacheValue({
            value: colorTemperatureInKelvin,
            featureName: 'colorTemperature',
          });
        },
      ),
    )();
  }

  /**
   * Some devices advertise the `setColor` operation but never actually
   * return a `color` feature in their live state — only `colorTemperature`.
   * This happens with tunable-white (CCT-only) bulbs whose Alexa skill
   * over-reports color capability. Treating that as a hard error causes
   * persistent "not responding" noise for a state that will never arrive.
   * In that specific case, fall back to a neutral (fully desaturated)
   * value instead of failing the characteristic read.
   */
  private fallbackColorValue(
    states: LightbulbState[],
    channel: 'hue' | 'saturation',
  ): O.Option<number> {
    const hasColorFeature = states.some(
      ({ featureName }) => featureName === 'color',
    );
    const hasColorTemperatureOnly =
      !hasColorFeature &&
      states.some(({ featureName }) => featureName === 'colorTemperature');

    if (!hasColorTemperatureOnly) {
      return O.none;
    }

    this.logWithContext(
      'debug',
      `Color state not available but colorTemperature is; defaulting ${channel} to 0`,
    );
    return O.of(0);
  }
}
