import {
  DataQueryRequest,
  DataQueryResponse,
  DataSourceApi,
  DataSourceInstanceSettings,
  Field,
  FieldType,
  MutableDataFrame,
  MetricFindValue,
} from '@grafana/data';
import { MyQuery, MyDataSourceOptions } from './types';
import axios from 'axios';
import jp from 'jsonpath';
import { getTemplateSrv } from '@grafana/runtime';

export class DataSource extends DataSourceApi<MyQuery, MyDataSourceOptions> {
  constructor(instanceSettings: DataSourceInstanceSettings<MyDataSourceOptions>) {
    super(instanceSettings);
  }

  async metricFindQuery(query: string, options?: any): Promise<MetricFindValue[]> {
    const queryText = options.variable.query.rawQuery;
    let response: any[] = [];

    switch (queryText) {
      case 'Persons':
        response = await getPersonsFromApi();
        break;
      case 'EntryPoints':
        response = await getEntryPointsFromTraps();
        break;
    }
    return response.map(item => ({ text: item, value: item }));
  }

  async query(options: DataQueryRequest<MyQuery>): Promise<DataQueryResponse> {
    try {
      let urlTraps = process.env.URLTraps;
      let urlSamplings = process.env.URLSamplings;
      try {
        await initializeApiCall(urlTraps!);
      } catch (error) {
        if (axios.isAxiosError(error)) {
          if (error.code === 'ERR_NETWORK') {
            urlTraps = "http://localhost:8080/v1/traps"
            urlSamplings = "http://localhost:8080/v1/samplings"
          }
        }
      }
      const [trapsInit, samplingsInit] = await Promise.all([
        initializeApiCall(urlTraps!),
        initializeApiCall(urlSamplings!)
      ]);

      const [responseDataTraps, responseDataSamplings] = await Promise.all([
        fetchDataFromAPI(urlTraps, trapsInit.totalCount, trapsInit.page_request_size, trapsInit.headers),
        fetchDataFromAPI(urlSamplings, samplingsInit.totalCount, samplingsInit.page_request_size, samplingsInit.headers)
      ]);

      if (!options.targets || options.targets.length === 0) { return { data: [] }; }

      const fromDate = options.range.from.toDate();
      const toDate = options.range.to.toDate();

      const filteredDataTraps = responseDataTraps.filter(item => new Date(item.installationDate) >= fromDate && new Date(item.installationDate) <= toDate);
      let filteredDataSamplings = responseDataSamplings.filter(item => new Date(item.date) >= fromDate && new Date(item.date) <= toDate);
      const fields: Field[] = [];
      let query;

      for (let i = 0; i < options.targets.length; i++) {
        const fieldName = options.targets[i]?.fieldName;
        const queryType = options.targets[i]?.queryType;
        let queryText = options.targets[i]?.queryText;
        query = getTemplateSrv().replace(queryText, options.scopedVars);

        if (!query || query.trim() === '') { continue; }

        if (query !== queryText) { query = transformQuery(query); }

        let queryResponseData;
        switch (queryType) {

          case 'Traps':
            queryResponseData = jp.query(filteredDataTraps, query);
            break;
          case 'Samplings':
            const trapsMap = responseDataTraps.reduce((map, trap) => {
              map[trap.id] = { entryPoint: trap.entryPoint, island: trap.island };
              return map;
            }, {});

            const fieldDetected = detectQueryField(query);
            if (fieldDetected === 'analyzes') {
              filteredDataSamplings = flattenAnalyzes(filteredDataSamplings);
            } else if (fieldDetected === 'results') {
              filteredDataSamplings = flattenAnalyzesAndResults(filteredDataSamplings);
            }

            const enhancedSamplings = filteredDataSamplings.map(sampling => {
              const trapData = trapsMap[sampling.trapId];
              return {
                ...sampling,
                entryPoint: trapData ? trapData.entryPoint : null,
                island: trapData ? trapData.island : null
              };
            });
            queryResponseData = jp.query(enhancedSamplings, query);
            break;
          default:
            queryResponseData = [];
            break;

        }

        const field: Field = {
          name: fieldName,
          type: FieldType.other,
          config: {},
          values: queryResponseData.map((value) => JSON.stringify(value))
        };

        fields.push(field);

      }

      const data = [new MutableDataFrame({ fields })];

      const areAllValuesEmpty = data[0].fields.every(field => field.values.length === 0);
      if (areAllValuesEmpty && query==="$[*].id") {
        console.log("Placeholder");
        return { data: [new MutableDataFrame({ fields: [{ name: "Placeholder", type: FieldType.other, values: [""] }] })] };
      }

      return { data };

    } catch (error) {
      console.error("Error en la consulta:", error);
      return { data: [] };
    }
  }

  async testDatasource() {
    return {
      status: 'success',
      message: 'Success',
    };
  }
}

function transformQuery(query: string) {
  let response = query;
  const regexField = /@\.[^=]+?\s*=='\{/g;
  const regexValues = /{([^}]+)}/g;
  const matchField = (response.match(regexField) || []).map(field => field.slice(0, -4));
  const matchValues = response.match(regexValues) || [];
  if (matchField && matchValues) {
    for (let i = 0; i < matchField.length; i++) {
      const field = matchField[i];
      const value = matchValues[i].slice(1, -1);
      const items = value.split(',').map(item => `${field} == '${item}'`).join(' || ');
      const escapedField = escapeRegExp(field);
      const regex = new RegExp(`${escapedField}=='{[^}]*}'`, 'g');
      response = response.replace(regex, items);
    }
  }
  response = response
    .replace(/@\.leavingDate\s*==\s*'ACTIVE'/g, '@.leavingDate == null')
    .replace(/@\.leavingDate\s*==\s*'INACTIVE'/g, '@.leavingDate')
    .replace(/@\.presenceOfIndividuals\s*==\s*'true'/g, '@.presenceOfIndividuals==true')
    .replace(/@\.presenceOfIndividuals\s*==\s*'false'/g, '@.presenceOfIndividuals==false');
  return response;
}

async function fetchDataFromAPI(url: any, totalCount: any, page_request_size: any, headers: any) {

  let responseData = [];
  const numberOfRequests = Math.ceil(totalCount / Number(page_request_size));
  for (let i = 1; i <= numberOfRequests; i++) {
    const response = await axios.get(`${url}?page=${i}&size=${page_request_size}`, { headers });
    responseData.push(...response.data);
  }
  return responseData;
}

async function fetchData(url: string, processFunction: (data: any) => any[]): Promise<any[]> {
  try {
    const { totalCount, page_request_size, headers } = await initializeApiCall(url);
    const responseData = await fetchDataFromAPI(url, totalCount, page_request_size, headers);
    return processFunction(responseData);
  } catch (error) {
    console.error("Error en la obtención de datos desde la API:", error);
    return [];
  }
}

function processPersonsData(responseData: any[]) {
  const persons = new Set(
    responseData.flatMap(sample =>
      sample.analyzes?.map((analysis: { person: any; }) => analysis.person).filter(Boolean) || []
    )
  );
  return Array.from(persons);
}

function processEntryPointsData(responseData: any[]) {
  const entryPoints = new Set(
    responseData.map((trap: { entryPoint: any; }) => trap.entryPoint).filter(Boolean)
  );
  return Array.from(entryPoints);
}

async function getPersonsFromApi() {
  try {
    await initializeApiCall(process.env.URLSamplings!);
    return fetchData(process.env.URLSamplings!, processPersonsData);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.code === 'ERR_NETWORK') {
        const alternativeValue = "http://localhost:8080/v1/samplings";
        return fetchData(alternativeValue, processPersonsData);
      }
    }
    console.error("Error al inicializar la llamada a la API para Samplings:", error);
    throw error;
  }
}

async function getEntryPointsFromTraps() {
    try {
        await initializeApiCall(process.env.URLTraps!);
        return fetchData(process.env.URLTraps!, processEntryPointsData);
    } catch (error) {
        if (axios.isAxiosError(error)) {
            if (error.code === 'ERR_NETWORK') {
                const alternativeValue = "http://localhost:8080/v1/traps";
                return fetchData(alternativeValue, processEntryPointsData);
            }
        }
        console.error("Error al inicializar la llamada a la API para Traps:", error);
        throw error;
    }
}

async function initializeApiCall(url: string) {
  const headers = { 'API_KEY': 'ROLE_ADMINISTRATOR' };
  const page_request_size = process.env.pageRequestSize;

  const initialResponse = await axios.get(url, { headers });
  const totalCount = initialResponse.headers['total-count'];

  return { totalCount, page_request_size, headers };
}

function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function flattenAnalyzes(data: any[]) {
  let flattenedData: any[] = [];

  data.forEach(item => {
    if (item.analyzes && Array.isArray(item.analyzes)) {
      item.analyzes.forEach((analyzes: any) => {
        let newItem = { ...item, analyzes: [{ ...analyzes }] };
        flattenedData.push(newItem);
      });
    }
  });

  return flattenedData;
}

function flattenAnalyzesAndResults(data: any[]) {
  let flattenedData: any[] = [];

  data.forEach(item => {
    if (item.analyzes && Array.isArray(item.analyzes)) {
      item.analyzes.forEach((analyzes: { results: any[]; }) => {
        if (analyzes.results && Array.isArray(analyzes.results)) {
          analyzes.results.forEach(result => {
            let newItem = {
              ...item,
              analyzes: [{ ...analyzes, results: [{ ...result }] }]
            };

            flattenedData.push(newItem);
          });
        } else {
          let newItem = {
            ...item,
            analyzes: [{ ...analyzes }]
          };

          flattenedData.push(newItem);
        }
      });
    }
  });

  return flattenedData;
}

function detectQueryField(query: string) {
  const hasAnalyzes = /@\.analyzes\b/.test(query);
  const hasResults = /\.analyzes\[\d+\]\.results\b/.test(query);

  if (hasAnalyzes && !hasResults) {
    return 'analyzes';
  } else if (hasResults) {
    return 'results';
  } else {
    return 'none';
  }
}
