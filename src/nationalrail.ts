///<reference path="../types/index.d.ts" />
import * as csv from 'csv-string';
import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';
import * as soap from 'soap';
import * as config from './trntxtconfig';
import { FromAndToStation, Station, NrService, DepartureObject, ErrorResponse, DepartureResponse, TrntxtService, ArrivalAndDepartureTimes, ArrivalTime } from './types';
const ignoreStations: [string] = require('../resources/ignore_stations.json');

const stations = loadStations('../resources/station_codes.csv');

const soapUrl = 'https://lite.realtime.nationalrail.co.uk/OpenLDBWS/wsdl.aspx?ver=2014-02-20';
const soapHeader = util.format('<AccessToken><TokenValue>%s</TokenValue></AccessToken>', config.API_KEY
  || console.error("No API key provided. Received: " + config.API_KEY));

function loadStations(filePath: string): Station[] {
  const stationFile = fs.readFileSync(path.join(__dirname, filePath), { encoding: 'utf-8' });
  let csvArray: string[][] = csv.parse(stationFile);
  csvArray = csvArray.filter(arr => {
    return (ignoreStations.indexOf(arr[1]) < 0);
  })
  const output: Station[] = csvArray.map(arr => {
    return {
      stationName: arr[0],
      stationCode: arr[1]
    }
  });
  return output;
}

function findStation(input: string): Station[] {
  let results: Station[] = [];
  input = sanitise(input);
  if (!input || input.length < 3) return results;

  // Find stations whose code matches the input.
  if (input.length === 3) {
    results = stations.filter(station => {
      return station.stationCode === input;
    });
    if (results.length > 0) {
      return results;
    }
  }

  // Results array is still empty. Try and compare names.
  // Filter station list to find station names containing all characters in the right order.
  results = stations.filter(station => {
    let stationName = sanitise(station.stationName);
    station.firstIndex = stationName.indexOf(input[0]);
    station.biggestChunk = biggestChunk(stationName, input);
    for (let i = 0; i < input.length; i++) {
      const index = stationName.indexOf(input[i]);
      if (index === -1) return false;
      stationName = stationName.substring(index + 1);
    }
    return true;
  });

  results = results.sort((stationA, stationB) => {
    if (stationA.firstIndex === stationB.firstIndex) {
      if (stationA.biggestChunk === stationB.biggestChunk) {
        return stationA.stationName.replace(/\(.*\)/, '').length - stationB.stationName.replace(/\(.*\)/, '').length;
      } else {
        return stationB.biggestChunk - stationA.biggestChunk;
      }
    } else {
      return stationA.firstIndex - stationB.firstIndex;
    }
  });

  return results;
}

function getStationNameFromCrs(crs: string): string {
  crs = crs.toUpperCase();
  const results = stations.filter(station => {
    return station.stationCode === crs;
  });
  if (results.length === 0) return null;
  else return results[0].stationName;
}

function biggestChunk(stationName: string, input: string): number {
  for (let i = input.length; i > 0; i--) {
    if (stationName.indexOf(input.substring(0, i - 1)) > -1) return i;
  }
  return 0;
}

function sanitise(input: string): string {
  if (input || input === '') {
    return input
      .toUpperCase()
      .replace('&', 'AND')
      .replace(/[^A-Z0-9]/g, '');
  }
  else return null;
}

function getDepartures(requestedStations: FromAndToStation, callback: (error: ErrorResponse, departureResponse?: DepartureResponse) => void) {
  if (config.API_KEY === undefined) {
    console.error('No API key set!');
    const error = { pageTitle: 'trntxt: ERROR', errorMessage: 'Error: No API key set.' };
    callback(error);
    return;
  }

  getDepartureObject(requestedStations, (err, departureObject) => {
    if (err) {
      console.error(err);
      const errorObject = { pageTitle: 'trntxt: ERROR', errorMessage: 'Error: Getting departures failed.' };
      return callback(errorObject, null);
    }
    const pugResponse: DepartureResponse = {
      departureObject: departureObject,
      pageTitle: 'trntxt: ' + departureObject.fromStation.stationCode,
      fromStation: departureObject.fromStation.stationCode,
      toStation: undefined
    };
    if (departureObject.toStation !== undefined) {
      pugResponse.pageTitle += ' > ' + departureObject.toStation.stationCode;
      pugResponse.toStation = departureObject.toStation.stationCode;
    }
    callback(null, pugResponse);
  });
}

function getDepartureObject(requestedStations: FromAndToStation, callback: (err: Error, departureObject?: DepartureObject) => void): void {
  const output: DepartureObject = {};
  output.fromStation = requestedStations.fromStation;
  if (requestedStations.toStation !== undefined) output.toStation = requestedStations.toStation;

  const options: { numRows?: number, crs: string, filterCrs?: string, timeOffset?: number, timeWindow?: number } = { // Added timeWindow (though not directly used below, kept for context)
    crs: requestedStations.fromStation.stationCode,
    // Fetch a wider window to potentially catch recently departed trains
    // Darwin default is -60 to +60. Let's try -90 to +120 (total 210 mins). Max window is 120. Let's use offset.
    // Fetch current board first (default offset 0, default window 120)
    // Then fetch previous board (offset -119, default window 120)
  };
  if (requestedStations.toStation !== undefined) {
    options.filterCrs = requestedStations.toStation.stationCode;
  }

  soap.createClient(soapUrl, (err: Error, client: any) => {
    if (err) return callback(err);
    client.addSoapHeader(soapHeader);

    // Make two calls: one for current/future, one for past
    const currentOptions = { ...options }; // Default offset 0
    const pastOptions = { ...options, timeOffset: -119 }; // Look back ~2 hours

    Promise.all([
      new Promise((resolve, reject) => client.GetDepartureBoard(currentOptions, (err: Error, result: any) => err ? reject(err) : resolve(result))),
      new Promise((resolve, reject) => client.GetDepartureBoard(pastOptions, (err: Error, result: any) => err ? reject(err) : resolve(result)))
    ]).then((results: any[]) => {
      const currentResult = results[0];
      const pastResult = results[1];

      // Combine services, ensuring uniqueness based on serviceID
      const serviceMap = new Map<string, NrService>();

      const processResults = (result: any) => {
        if (result?.GetStationBoardResult?.trainServices?.service) {
          // Ensure service is an array even if only one is returned
          const services = Array.isArray(result.GetStationBoardResult.trainServices.service)
            ? result.GetStationBoardResult.trainServices.service
            : [result.GetStationBoardResult.trainServices.service];
          services.forEach((s: NrService) => serviceMap.set(s.serviceID, s));
        }
        // Note: Ignoring bus services for departed logic for now
      };

      processResults(pastResult); // Process past first, so current overrides duplicates
      processResults(currentResult);

      const combinedTrainServices = Array.from(serviceMap.values());

      // Handle NRCC messages (prefer current result's messages)
      if (currentResult?.GetStationBoardResult?.nrccMessages) {
        output.nrccMessages = currentResult.GetStationBoardResult.nrccMessages.message;
        for (let i = 0; i < output.nrccMessages.length; i++) {
          output.nrccMessages[i] = reformatNrccMessage(output.nrccMessages[i]);
        }
      } else if (pastResult?.GetStationBoardResult?.nrccMessages) {
        // Fallback to past messages if current has none
        output.nrccMessages = pastResult.GetStationBoardResult.nrccMessages.message;
         for (let i = 0; i < output.nrccMessages.length; i++) {
          output.nrccMessages[i] = reformatNrccMessage(output.nrccMessages[i]);
        }
      }

      // Process the combined list
      processDarwinServices(combinedTrainServices as [NrService], requestedStations, (err, processedServices) => {
        if (err) return callback(err); // Handle error from processDarwinServices

        output.upcomingTrainServices = processedServices.upcoming;
        output.recentlyDepartedServices = processedServices.departed;

        // Handle Bus Services (using only current results for simplicity)
        let aBusServices = currentResult?.GetStationBoardResult?.busServices ? currentResult.GetStationBoardResult.busServices.service : [];
        // Ensure bus services is an array
        if (aBusServices && !Array.isArray(aBusServices)) {
            aBusServices = [aBusServices];
        } else if (!aBusServices) {
            aBusServices = [];
        }

        // Process bus services (assuming they don't need departed logic)
         processDarwinServices(aBusServices, { fromStation: requestedStations.fromStation }, (err, busResult) => {
           if (err) {
             console.error("Error processing bus services:", err);
             output.busServices = []; // Assign empty on error
           } else {
             output.busServices = busResult.upcoming; // Assign only upcoming buses
           }
           return callback(null, output); // Final callback
         });
      });

    }).catch(err => {
      // Handle error from soap calls
      console.error("Error fetching departure board:", err);
      fs.writeFile('public/lasterror.txt', JSON.stringify(err, null, 2), writeErr => {
        if (writeErr) console.error("Error writing error log:", writeErr);
      });
      return callback(err);
    });
  });
}

function reformatNrccMessage(input: string): string {
  const sanitised = removeHtmlTagsExceptA(input);
  return sanitised.replace('"http://nationalrail.', '"https://www.nationalrail.');
}

function removeHtmlTagsExceptA(input: string): string {
  if (!input) return '';
  return input.replace(/<\/?((([^\/a>]|a[^> ])[^>]*)|)>/ig, '');
}

function processDarwinServices(aServices: NrService[], requestedStations: FromAndToStation, callback: (error: Error, services: { upcoming: TrntxtService[], departed: TrntxtService[] }) => void): void {
  // Ensure aServices is always an array
  if (!Array.isArray(aServices)) {
    aServices = aServices ? [aServices] : [];
  }

  const processedServices: TrntxtService[] = [];
  const aPromises: Promise<any>[] = []; // Explicitly type the array

  // 1. Create basic service objects and prepare promises if needed
  for (let i = 0; i < aServices.length; i++) {
    const service: TrntxtService = {};
    // Ensure origin and destination structures are valid before accessing properties
    if (aServices[i]?.origin?.location?.[0]) {
        service.originStation = {
            stationName: aServices[i].origin.location[0].locationName,
            stationCode: aServices[i].origin.location[0].crs
        };
    } else {
        // Handle cases where origin might be missing (though unlikely for departures)
        service.originStation = { stationName: 'Unknown', stationCode: '???' };
        console.warn(`Service ${aServices[i]?.serviceID} missing origin information.`);
    }

    if (aServices[i]?.destination?.location?.[0]) {
        service.destinationStation = {
            stationName: aServices[i].destination.location[0].locationName,
            stationCode: aServices[i].destination.location[0].crs
        };
    } else {
        // Handle cases where destination might be missing
        service.destinationStation = { stationName: 'Unknown', stationCode: '???' };
        console.warn(`Service ${aServices[i]?.serviceID} missing destination information.`);
    }
    // Removed extra closing brace here
    // Copy basic details
    service.std = aServices[i].std;
    service.etd = aServices[i].etd;
    service.platform = aServices[i].platform ? aServices[i].platform : null;
    service.operator = aServices[i].operator;
    service.serviceID = aServices[i].serviceID;
    // Removed duplicated block below

    processedServices.push(service); // Add the basic service object

    // If a destination is specified, prepare a promise to fetch its details
    if (requestedStations.toStation && service.serviceID) {
      aPromises.push(makePromiseForService(service.serviceID));
    }
  }

  // 2. Fetch details if needed
  Promise.all(aPromises).then(detailedServices => {
    // Create a map for easy lookup of details by serviceID
    const detailsMap = new Map<string, any>();
    // Add explicit type for 'detail' parameter
    detailedServices.forEach((detail: any) => {
      if (detail?.GetServiceDetailsResult?.serviceID) {
        detailsMap.set(detail.GetServiceDetailsResult.serviceID, detail);
      }
    });

    const finalServices: TrntxtService[] = [];

    // 3. Augment services with arrival details and filter
    for (let i = 0; i < processedServices.length; i++) {
      const service = processedServices[i];
      let keepService = true; // Assume we keep the service unless filtered out

      if (requestedStations.toStation) {
        const detail = detailsMap.get(service.serviceID);
        if (detail) {
          const arrival = getArrivalTimeForService(detail, requestedStations.toStation);
          service.sta = arrival.sta;
          service.eta = arrival.eta;
          service.arrivalStation = arrival.arrivalStation;
          service.correctStation = arrival.correctStation;
          const mins = getServiceTime(service);
          service.time = formatTime(mins);

          // Filter out services that don't call at the requested 'to' station
          if (!service.correctStation) {
            keepService = false;
          }
        } else {
          // If details were required but couldn't be fetched, filter out the service
          console.warn(`Details required but not found/fetched for service ${service.serviceID}. Filtering out.`);
          keepService = false;
        }
      }

      if (keepService) {
        finalServices.push(service);
      }
    }

    // 4. Categorize filtered services into upcoming and departed
    const upcomingOutput: TrntxtService[] = [];
    const departedOutput: TrntxtService[] = [];
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    for (let i = 0; i < finalServices.length; i++) {
        const service = finalServices[i];
        let departureMinutes = toMins(service.etd);
        if (departureMinutes < 0) {
            departureMinutes = toMins(service.std);
        }

        if (departureMinutes >= 0) {
            const timeDiff = currentMinutes - departureMinutes;
            const departedYesterday = departureMinutes > (currentMinutes + 60); // Approx check for yesterday
            const departedToday = timeDiff > 0 && timeDiff < 720; // Departed within last 12 hours today

            if (departedToday || departedYesterday) {
                service.departureMinutes = departureMinutes; // Store for sorting
                departedOutput.push(service);
            } else {
                upcomingOutput.push(service);
            }
        } else {
            // Services without a valid time (e.g., cancelled before departure) go to upcoming
            upcomingOutput.push(service);
        }
    }

    // 5. Sort departed services and take top 2
    departedOutput.sort((a, b) => {
        const aDepMins = a.departureMinutes;
        const bDepMins = b.departureMinutes;
        if (aDepMins < 120 && bDepMins > 1320) return 1; // b is more recent (yesterday evening vs today morning)
        if (bDepMins < 120 && aDepMins > 1320) return -1; // a is more recent
        return bDepMins - aDepMins; // Normal descending sort
    });
    const recentlyDepartedServices = departedOutput.slice(0, 2);

    // 6. Return results
    return callback(null, { upcoming: upcomingOutput, departed: recentlyDepartedServices });

  }).catch(error => {
    // Handle errors during detail fetching
    console.error("Error fetching service details:", error);
    // Fallback: Categorize without arrival details
    const upcomingOutput: TrntxtService[] = [];
    const departedOutput: TrntxtService[] = [];
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    for (let i = 0; i < processedServices.length; i++) {
        const service = processedServices[i];
        // Filter out services if 'toStation' was requested but details failed
        if (requestedStations.toStation) {
            console.warn(`Excluding service ${service.serviceID} due to failed detail fetch.`);
            continue; // Skip this service
        }

        let departureMinutes = toMins(service.etd);
        if (departureMinutes < 0) {
            departureMinutes = toMins(service.std);
        }

        if (departureMinutes >= 0) {
            const timeDiff = currentMinutes - departureMinutes;
            const departedYesterday = departureMinutes > (currentMinutes + 60);
            const departedToday = timeDiff > 0 && timeDiff < 720;

            if (departedToday || departedYesterday) {
                service.departureMinutes = departureMinutes;
                departedOutput.push(service);
            } else {
                upcomingOutput.push(service);
            }
        } else {
            upcomingOutput.push(service);
        }
    }

    departedOutput.sort((a, b) => {
        const aDepMins = a.departureMinutes;
        const bDepMins = b.departureMinutes;
        if (aDepMins < 120 && bDepMins > 1320) return 1;
        if (bDepMins < 120 && aDepMins > 1320) return -1;
        return bDepMins - aDepMins;
    });
    const recentlyDepartedServices = departedOutput.slice(0, 2);

    return callback(null, { upcoming: upcomingOutput, departed: recentlyDepartedServices });
  });
}


function getArrivalTimeForService(serviceDetailsResult: any, toStation: Station): ArrivalTime {
  const output: ArrivalTime = { correctStation: false }; // Default to false

  // Check if the expected structure exists
  const callingPointsList = serviceDetailsResult?.GetServiceDetailsResult?.subsequentCallingPoints?.callingPointList;
  if (!callingPointsList || !Array.isArray(callingPointsList) || callingPointsList.length === 0) {
    console.warn(`Service ${serviceDetailsResult?.GetServiceDetailsResult?.serviceID}: No subsequent calling points found.`);
    return output; // Return default (correctStation: false)
  }

  // Assuming the first element of callingPointList contains the relevant array
  const callingPointArray = callingPointsList[0]?.callingPoint;
  if (!Array.isArray(callingPointArray)) {
     console.warn(`Service ${serviceDetailsResult?.GetServiceDetailsResult?.serviceID}: Subsequent calling points format unexpected.`);
     return output;
  }

  for (let i = 0; i < callingPointArray.length; i++) {
    const point = callingPointArray[i];
    if (point?.crs === toStation.stationCode) {
      output.sta = point.st;
      output.eta = point.et;
      output.arrivalStation = getStationNameFromCrs(point.crs); // Use the actual station code from the data
      output.correctStation = true; // Found the requested station
      break; // Stop searching
    }
  }

  // If the loop finishes without finding the station, correctStation remains false.
  // We don't need the 'else if' part that previously assigned the last station.
  return output;
}


function makePromiseForService(serviceId: string): Promise<any> { // Return type any as SOAP result varies
  const options = { serviceID: serviceId };
  return new Promise((resolve, reject) => {
    soap.createClient(soapUrl, (err: Error, client: any) => {
      if (err) {
        console.error(`SOAP client creation failed for service ${serviceId}:`, err);
        return reject(err); // Reject promise if client creation fails
      }
      client.addSoapHeader(soapHeader);
      client.GetServiceDetails(options, (err: Error, result: any) => {
        if (err) {
          // Log error but resolve with null to avoid breaking Promise.all for one failed service
          console.error(`GetServiceDetails failed for service ${serviceId}:`, err);
          return resolve(null);
        }
        // Add serviceID to the result for easier mapping later
        if (result?.GetServiceDetailsResult) {
            result.GetServiceDetailsResult.serviceID = serviceId;
        }
        return resolve(result);
      });
    });
  });
}

/**
 * Takes a string in hh:mm format and returns the number of minutes
 */
function toMins(time: string): number {
  if (!time) return -1;
  time = time.replace(/([^0-9:])/, '');
  const array = time.split(':');
  if (array.length < 2) return -1;
  const h = parseInt(array[0]);
  const m = parseInt(array[1]);
  if (isNaN(h) || isNaN(m)) {
    return -1;
  } else {
    return (60 * h) + m;
  }
}

/**
 * Takes an object with eta, sta, etd and std properties.
 * 
 * Returns the number of minutes a service should take,
 *   giving preference to the estimated timings
 */
function getServiceTime(timings: ArrivalAndDepartureTimes): number {
  let arrival = toMins(timings.eta);
  if (arrival < 0) {
    arrival = toMins(timings.sta);
  }
  let departure = toMins(timings.etd);
  if (departure < 0) {
    departure = toMins(timings.std);
  }
  if (arrival < 0 || departure < 0) return -1;
  let mins = arrival - departure;
  if (mins < 0) {
    mins += 1440;
  }
  return mins;
}

/**
 * Turns minutes into something like 1h 5m
 */
function formatTime(mins: number): string {
  if (mins < 0) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0) return `${h}h ${m}m`;
  else return m + 'm';
}

export {
  findStation,
  formatTime,
  getDepartures,
  getServiceTime,
  reformatNrccMessage,
  sanitise,
  stations,
  toMins
}
