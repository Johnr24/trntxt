type Station = {
  stationName: string,
  stationCode: string,
  firstIndex?: number,
  biggestChunk?: number
}

class FromAndToStation {
  fromStation: Station;
  toStation?: Station; // <-- ADD the '?' here to make the property optional
  didYouMean?: {
    from: Station[],
    to: Station[]
  }
  constructor(fromStation?: Station, toStation?: Station) {
    this.fromStation = fromStation;
    this.toStation = toStation;
  }
}

type NrService = any;

type DepartureObject = {
  fromStation?: Station,
  toStation?: Station,
  upcomingTrainServices?: NrService[], // <-- RENAME from trainServices
  recentlyDepartedServices?: TrntxtService[], // <-- ADD
  busServices?: NrService[],
  nrccMessages?: [string]
}

type ErrorResponse = {
  pageTitle: string,
  errorMessage: string
}

type DepartureResponse = {
  departureObject: DepartureObject,
  pageTitle: string,
  fromStation: string,
  toStation: string
}
type TrntxtService = any & { // Combine with existing 'any' or define specific properties
  departureMinutes?: number; // <-- ADD (used internally for sorting)
};

type ArrivalAndDepartureTimes = {
  eta: string,
  etd: string,
  sta: string,
  std: string
}

type ArrivalTime = {
  sta?: string,
  eta?: string,
  arrivalStation?: string,
  correctStation?: boolean
}

export {
  Station,
  FromAndToStation,
  NrService,
  DepartureObject,
  ErrorResponse,
  DepartureResponse,
  TrntxtService,
  ArrivalAndDepartureTimes,
  ArrivalTime
}
