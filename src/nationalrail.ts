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

function processDarwinServices(aServices: [NrService], requestedStations: FromAndToStation, callback: (error: Error, services: { upcoming: TrntxtService[], departed: TrntxtService[] }) => void): void {
  const upcomingOutput: TrntxtService[] = [];
  const departedOutput: TrntxtService[] = [];
  const aPromises = [];

  const now = new Date();
  // Calculate current time in minutes past midnight
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  for (let i = 0; i < aServices.length; i++) {
    const service: TrntxtService = {}; // Create the basic service object
    service.originStation = {
      stationName: aServices[i].origin.location[0].locationName,
      stationCode: aServices[i].origin.location[0].crs
    };
    service.destinationStation = {
      stationName: aServices[i].destination.location[0].locationName,
      stationCode: aServices[i].destination.location[0].crs
    };
    service.std = aServices[i].std;
    service.etd = aServices[i].etd;
    service.platform = aServices[i].platform ? aServices[i].platform : null;
    service.operator = aServices[i].operator;
    service.serviceID = aServices[i].serviceID;

    // Determine departure time in minutes
    let departureMinutes = toMins(service.etd);
    if (departureMinutes < 0) { // If etd is not a valid time (e.g., 'On time', 'Cancelled', 'Delayed')
      departureMinutes = toMins(service.std); // Try std
    }

    // Categorize based on time
    if (departureMinutes >= 0) { // Only categorize if we have a valid time
      // Handle potential day rollover for sorting: if departure is much earlier than now, assume it was yesterday
      const timeDiff = currentMinutes - departureMinutes;
      // Check if departed: timeDiff is positive (departure is in the past)
      // and less than 720 minutes (12 hours) ago.
      // Also handle the midnight wrap-around: if timeDiff is large negative (e.g. -1380 for 23:00 vs 00:00), it means it departed yesterday.
      // A simple check: if departureMinutes is significantly larger than currentMinutes, it likely belongs to the previous day.
      const departedYesterday = departureMinutes > (currentMinutes + 60); // e.g., current 00:10 (10), departure 23:50 (1430)
      const departedToday = timeDiff > 0 && timeDiff < 720; // Departed within the last 12 hours today

      if (departedToday || departedYesterday) {
        service.departureMinutes = departureMinutes; // Store for sorting
        departedOutput.push(service);
      } else { // Either in the future or departed long ago (treat as upcoming for display)
        upcomingOutput.push(service);
        // If it's an upcoming service and we need arrival times, prepare the promise
        if (requestedStations.toStation) {
          aPromises.push(makePromiseForService(service.serviceID));
        }
      }
    } else {
      // If no valid time (e.g., cancelled/delayed services yet to depart), assume it's upcoming
      upcomingOutput.push(service);
      // Still need arrival times for these if toStation is specified
      if (requestedStations.toStation) {
        aPromises.push(makePromiseForService(service.serviceID));
      }
    }
  }

  // Sort departed services (most recent first) and keep top 2
  // Adjust sorting for midnight wrap-around: treat times just before midnight as later than times just after midnight
  departedOutput.sort((a, b) => {
      const aDepMins = a.departureMinutes;
      const bDepMins = b.departureMinutes;
      // Simple approach: if one time is < 120 (before 2 AM) and the other is > 1320 (after 10 PM),
      // assume the > 1320 time is more recent (yesterday evening vs today morning).
      if (aDepMins < 120 && bDepMins > 1320) return 1; // b is more recent
      if (bDepMins < 120 && aDepMins > 1320) return -1; // a is more recent
      // Otherwise, normal descending sort
      return bDepMins - aDepMins;
  });
  const recentlyDepartedServices = departedOutput.slice(0, 2);

  // Process arrival times only for upcoming services that need them
  Promise.all(aPromises).then(detailedServices => {
    const upcomingWithArrivals: TrntxtService[] = [];
    let detailIndex = 0; // Keep track of which detailed service corresponds to which upcoming service

    for (let i = 0; i < upcomingOutput.length; i++) {
      const service = upcomingOutput[i];
      let needsDetails = false;
      // Check if this service corresponds to one of the promises we made
      if (requestedStations.toStation) {
          // Find if a promise was made for this serviceID (needed because promises array only contains those needing details)
          const promiseIndex = aPromises.findIndex(p => p.serviceID === service.serviceID); // Assumes makePromiseForService attaches serviceID or similar context, which it doesn't currently. Let's rethink.
          // Simpler: If toStation exists, *all* upcoming services had a promise created for them earlier.
          needsDetails = true;
      }


      // Only process details if a toStation was requested for this service
      if (needsDetails && aPromises.length > detailIndex && detailedServices[detailIndex]) {
          const arrival = getArrivalTimeForService(detailedServices[detailIndex], requestedStations.toStation);
          service.sta = arrival.sta;
          service.eta = arrival.eta;
          service.arrivalStation = arrival.arrivalStation;
          service.correctStation = arrival.correctStation;
          const mins = getServiceTime(service);
          service.time = formatTime(mins);
          detailIndex++; // Move to the next detailed service result

          // Only keep upcoming services that actually call at the destination
          if (service.correctStation) {
              upcomingWithArrivals.push(service);
          }
          // If !service.correctStation, it means the service runs but doesn't stop at the requested 'toStation'.
          // We filter these out when a 'toStation' is specified.
      } else if (!requestedStations.toStation) {
          // If no toStation, keep the service as is (no arrival details needed/fetched)
          upcomingWithArrivals.push(service);
      } else if (needsDetails && (!detailedServices[detailIndex] || aPromises.length <= detailIndex)) {
          // Handle case where detail fetch might have failed for a specific service or index mismatch
          console.warn(`Missing or failed detail for service ID ${service.serviceID}. Skipping arrival info.`);
          upcomingWithArrivals.push(service); // Keep service but without arrival details
          if (aPromises.length > detailIndex) detailIndex++; // Increment index even on failure to avoid cascade
      }
      // If needsDetails was true but correctStation was false, it's implicitly filtered out by not being pushed.
    }


    // Return both lists
    return callback(null, { upcoming: upcomingWithArrivals, departed: recentlyDepartedServices });

  }, error => {
    console.error("Error fetching service details:", error);
    // Decide how to handle partial failure: return only departed? Return upcoming without arrival times?
    // For now, return upcoming without arrival times and the departed list.
    const upcomingWithoutArrivals = upcomingOutput.map(service => {
        // Remove any potentially stale arrival data if details failed
        delete service.sta;
        delete service.eta;
        delete service.arrivalStation;
        delete service.correctStation;
        delete service.time;
        return service;
    });
    return callback(null, { upcoming: upcomingWithoutArrivals, departed: recentlyDepartedServices });
  });
}


function getArrivalTimeForService(service: any, toStation: Station): ArrivalTime {
  const output: ArrivalTime = {};
  const callingPointArray = service.GetServiceDetailsResult.subsequentCallingPoints.callingPointList[0].callingPoint;
  for (let i = 0; i < callingPointArray.length; i++) {
    if (callingPointArray[i].crs === toStation.stationCode) {
      output.sta = callingPointArray[i].st;
      output.eta = callingPointArray[i].et;
      output.arrivalStation = getStationNameFromCrs(toStation.stationCode);
      output.correctStation = true;
      break;
    } else if (i === callingPointArray.length - 1) {
      output.sta = callingPointArray[i].st;
      output.eta = callingPointArray[i].et;
      output.arrivalStation = getStationNameFromCrs(callingPointArray[i].crs);
      output.correctStation = false;
    }
  }
  return output;
}

function makePromiseForService(serviceId: string): Promise<NrService> {
  const options = { serviceID: serviceId };
  return new Promise((resolve, reject) => {
    soap.createClient(soapUrl, (err: Error, client: any) => {
      client.addSoapHeader(soapHeader);
      client.GetServiceDetails(options, (err: Error, result: any) => {
        if (err) return reject(err);
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
