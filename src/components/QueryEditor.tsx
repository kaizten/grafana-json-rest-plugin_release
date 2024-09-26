import React, { ChangeEvent } from 'react';
import { InlineField, Input } from '@grafana/ui';
import { QueryEditorProps } from '@grafana/data';
import { DataSource } from '../datasource';
import { MyDataSourceOptions, MyQuery } from '../types';

type Props = QueryEditorProps<DataSource, MyQuery, MyDataSourceOptions>;

export function QueryEditor({ query, onChange, onRunQuery }: Props) {

  const onQueryTextChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange({ ...query, queryText: event.target.value });
    onRunQuery();
  };

  const onFieldNameChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange({ ...query, fieldName: event.target.value });
    onRunQuery();
  };

  const onQueryTypeChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange({ ...query, queryType: event.target.value });
    onRunQuery();
  };

  return (
    <div className="gf-form">
      <InlineField label="Type Query" labelWidth={16} tooltip="Not used yet">
        <Input onChange={onQueryTypeChange} value={query.queryType || ''} />
      </InlineField>
      <InlineField label="Query Text" labelWidth={16} tooltip="Not used yet">
        <Input onChange={onQueryTextChange} value={query.queryText || ''} />
      </InlineField>
      <InlineField label="Field Name" labelWidth={16} tooltip="Not used yet">
        <Input onChange={onFieldNameChange} value={query.fieldName || ''} />
      </InlineField>
    </div>
  );
}
