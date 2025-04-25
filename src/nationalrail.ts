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

  const options: { numRows?: number, crs: string, filterCrs?: string, timeOffset?: number, timeWindow?: number } = {
    crs: requestedStations.fromStation.stationCode,
    numRows: 20 // Fetch more rows to ensure we get enough data for both upcoming and departed
  };
  if (requestedStations.toStation !== undefined) {
    options.filterCrs = requestedStations.toStation.stationCode;
  }

  soap.createClient(soapUrl, (err: Error, client: any) => {
    if (err) return callback(err);
    client.addSoapHeader(soapHeader);

    // Make two calls: one for current/future, one for past
    const currentOptions = { ...options }; // Default offset 0, default window 120
    const pastOptions = { ...options, timeOffset: -120, timeWindow: 120 }; // Look back 2 hours

    Promise.all([
      new Promise((resolve, reject) => client.GetDepartureBoard(currentOptions, (err: Error, result: any) => err ? reject(err) : resolve(result))),
      new Promise((resolve, reject) => client.GetDepartureBoard(pastOptions, (err: Error, result: any) => err ? reject(err) : resolve(result)))
    ]).then((results: any[]) => {
      const currentResult = results[0];
      const pastResult = results[1];

      // Process current services for upcoming trains
      const upcomingServices: NrService[] = [];
      if (currentResult?.GetStationBoardResult?.trainServices?.service) {
        const services = Array.isArray(currentResult.GetStationBoardResult.trainServices.service)
          ? currentResult.GetStationBoardResult.trainServices.service
          : [currentResult.GetStationBoardResult.trainServices.service];
        upcomingServices.push(...services);
      }

      // Process past services for departed trains
      const departedServices: NrService[] = [];
      if (pastResult?.GetStationBoardResult?.trainServices?.service) {
        const services = Array.isArray(pastResult.GetStationBoardResult.trainServices.service)
          ? pastResult.GetStationBoardResult.trainServices.service
          : [pastResult.GetStationBoardResult.trainServices.service];
        departedServices.push(...services);
      }

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

      // Process upcoming services
      processDarwinServices(upcomingServices as [NrService], requestedStations, false, (err, upcomingProcessed) => {
        if (err) return callback(err);
        
        output.upcomingTrainServices = upcomingProcessed;
        
        // Process departed services separately
        processDarwinServices(departedServices as [NrService], requestedStations, true, (err, departedProcessed) => {
          if (err) {
            console.error("Error processing departed services:", err);
            output.recentlyDepartedServices = []; // Empty on error
          } else {
            // Sort departed services by departure time (most recent first)
            departedProcessed.sort((a, b) => {
              const aTime = toMins(a.std);
              const bTime = toMins(b.std);
              // Handle day boundary (e.g., 23:45 vs 00:15)
              if (Math.abs(aTime - bTime) > 720) {
                return aTime > bTime ? -1 : 1; // Reverse for day boundary
              }
              return bTime - aTime; // Most recent first
            });
            
            // Take only the 2 most recent
            output.recentlyDepartedServices = departedProcessed.slice(0, 2);
          }
          
          // Handle Bus Services (using only current results)
          let aBusServices = currentResult?.GetStationBoardResult?.busServices ? currentResult.GetStationBoardResult.busServices.service : [];
          // Ensure bus services is an array
          if (aBusServices && !Array.isArray(aBusServices)) {
              aBusServices = [aBusServices];
          } else if (!aBusServices) {
              aBusServices = [];
          }

          // Process bus services (no departed logic for buses)
          processDarwinServices(aBusServices, { fromStation: requestedStations.fromStation }, false, (err, busResult) => {
            if (err) {
              console.error("Error processing bus services:", err);
              output.busServices = []; // Assign empty on error
            } else {
              output.busServices = busResult; // Assign processed buses
            }
            return callback(null, output); // Final callback
          });
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

function processDarwinServices(aServices: NrService[], requestedStations: FromAndToStation, isDeparted: boolean, callback: (error: Error, services: TrntxtService[]) => void): void {
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
    
    // Copy basic details
    service.std = aServices[i].std;
    service.etd = aServices[i].etd;
    service.platform = aServices[i].platform ? aServices[i].platform : null;
    service.operator = aServices[i].operator;
    service.serviceID = aServices[i].serviceID;
    
    // For departed services, check if they're actually in the past
    if (isDeparted) {
      const now = new Date();
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      const departureMinutes = toMins(service.std);
      
      // Skip if this is actually a future service
      if (departureMinutes > currentMinutes && (departureMinutes - currentMinutes) < 120) {
        continue; // This is a future service, skip it
      }
    }

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

    return callback(null, finalServices);

  }).catch(error => {
    // Handle errors during detail fetching
    console.error("Error fetching service details:", error);
    
    // If we need destination details but failed to get them, return empty array
    if (requestedStations.toStation) {
      return callback(null, []);
    }
    
    // Otherwise return the basic processed services
    return callback(null, processedServices);
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
