/* eslint-disable react/jsx-key, react/prop-types */
import React, { useMemo, useState, useRef, useCallback } from 'react';
import { DimItem } from 'app/inventory/item-types';
import { AppIcon, faCaretUp, faCaretDown } from 'app/shell/icons';
import styles from './ItemTable.m.scss';
import { ItemCategoryTreeNode } from './ItemTypeSelector';
import _ from 'lodash';
import { ItemInfos, TagInfo } from 'app/inventory/dim-item-info';
import { DtrRating } from 'app/item-review/dtr-api-types';
import { InventoryWishListRoll } from 'app/wishlists/wishlists';
import { loadingTracker } from 'app/shell/loading-tracker';
import { showNotification } from 'app/notifications/notifications';
import { t } from 'app/i18next-t';
import { D2ManifestDefinitions } from 'app/destiny2/d2-definitions';
import ItemActions from './ItemActions';
import { DimStore } from 'app/inventory/store-types';
import EnabledColumnsSelector from './EnabledColumnsSelector';
import { bulkTagItems } from 'app/inventory/tag-items';
import { connect } from 'react-redux';
import { createSelector } from 'reselect';
import { RootState, ThunkDispatchProp } from 'app/store/reducers';
import { storesSelector, itemInfosSelector } from 'app/inventory/selectors';
import { searchFilterSelector } from 'app/search/search-filters';
import { inventoryWishListsSelector } from 'app/wishlists/reducer';
import { toggleSearchQueryComponent } from 'app/shell/actions';
import clsx from 'clsx';
import { useShiftHeld } from 'app/utils/hooks';
import { newLoadout, convertToLoadoutItem } from 'app/loadout/loadout-utils';
import { applyLoadout } from 'app/loadout/loadout-apply';
import { getColumns, getColumnSelectionId } from './Columns';
import { ratingsSelector } from 'app/item-review/reducer';
import { DestinyClass } from 'bungie-api-ts/destiny2';
import { setItemLockState } from 'app/inventory/item-move-service';
import { emptyObject, emptyArray } from 'app/utils/empty';
import { Row, ColumnDefinition, SortDirection, ColumnSort } from './table-types';
import { compareBy, chainComparator, reverseComparator } from 'app/utils/comparators';
import { touch, setItemNote } from 'app/inventory/actions';
import { settingsSelector } from 'app/settings/reducer';
import { setSetting } from 'app/settings/actions';
import { KeyedStatHashLists } from 'app/dim-ui/CustomStatTotal';
import { Loadout } from 'app/loadout/loadout-types';
import { loadoutsSelector } from 'app/loadout/reducer';

const categoryToClass = {
  23: DestinyClass.Hunter,
  22: DestinyClass.Titan,
  21: DestinyClass.Warlock
};

interface ProvidedProps {
  categories: ItemCategoryTreeNode[];
}

interface StoreProps {
  stores: DimStore[];
  items: DimItem[];
  defs: D2ManifestDefinitions;
  itemInfos: ItemInfos;
  ratings: { [key: string]: DtrRating };
  wishList: {
    [key: string]: InventoryWishListRoll;
  };
  isPhonePortrait: boolean;
  enabledColumns: string[];
  customTotalStatsByClass: KeyedStatHashLists;
  loadouts: Loadout[];
  newItems: Set<string>;
}

function mapStateToProps() {
  const itemsSelector = createSelector(
    storesSelector,
    searchFilterSelector,
    (_, props: ProvidedProps) => props.categories,
    (stores, searchFilter, categories) => {
      const terminal = Boolean(_.last(categories)?.terminal);
      if (!terminal) {
        return emptyArray<DimItem>();
      }
      const categoryHashes = categories.map((s) => s.itemCategoryHash).filter((h) => h > 0);
      const items = stores.flatMap((s) =>
        s.items.filter(
          (i) =>
            i.comparable &&
            categoryHashes.every((h) => i.itemCategoryHashes.includes(h)) &&
            searchFilter(i)
        )
      );
      return items;
    }
  );

  // TODO: make the table a subcomponent so it can take the subtype as an argument?
  return (state: RootState, props: ProvidedProps): StoreProps => {
    const items = itemsSelector(state, props);
    const isArmor = items[0]?.bucket.inArmor;
    return {
      items,
      defs: state.manifest.d2Manifest!,
      stores: storesSelector(state),
      itemInfos: itemInfosSelector(state),
      ratings: $featureFlags.reviewsEnabled ? ratingsSelector(state) : emptyObject(),
      wishList: inventoryWishListsSelector(state),
      isPhonePortrait: state.shell.isPhonePortrait,
      enabledColumns: settingsSelector(state)[
        isArmor ? 'organizerColumnsArmor' : 'organizerColumnsWeapons'
      ],
      customTotalStatsByClass: settingsSelector(state).customTotalStatsByClass,
      loadouts: loadoutsSelector(state),
      newItems: state.inventory.newItems
    };
  };
}

type Props = ProvidedProps & StoreProps & ThunkDispatchProp;

// Functions:
// TODO: better display for nothing matching
// TODO: sticky toolbar
// TODO: drop wishlist columns if no wishlist loaded
// TODO: d1 support?
// TODO: special stat display? recoil, bars, etc
// TODO: some basic optimization
// TODO: Indicate equipped/owner? Not sure it's necessary.

function ItemTable({
  items,
  categories,
  itemInfos,
  ratings,
  wishList,
  defs,
  stores,
  enabledColumns,
  customTotalStatsByClass,
  loadouts,
  newItems,
  dispatch
}: Props) {
  const [columnSorts, setColumnSorts] = useState<ColumnSort[]>([
    { columnId: 'name', sort: SortDirection.ASC }
  ]);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  // Track the last selection for shift-selecting
  const lastSelectedId = useRef<string | null>(null);

  const isArmor = items[0]?.bucket.inArmor;

  // TODO: filter here, or in the mapState function?
  // Narrow items to selection
  items = useMemo(() => {
    const terminal = Boolean(_.last(categories)?.terminal);
    const categoryHashes = categories.map((s) => s.itemCategoryHash).filter((h) => h > 0);
    return terminal
      ? items.filter((item) => categoryHashes.every((h) => item.itemCategoryHashes.includes(h)))
      : emptyArray();
  }, [items, categories]);

  const classCategoryHash =
    categories.map((n) => n.itemCategoryHash).find((hash) => hash in categoryToClass) ?? 999;
  const classIfAny: DestinyClass = categoryToClass[classCategoryHash]! ?? DestinyClass.Unknown;

  // TODO: hide columns if all undefined
  const columns: ColumnDefinition[] = useMemo(
    () =>
      getColumns(
        items,
        defs,
        itemInfos,
        ratings,
        wishList,
        customTotalStatsByClass[classIfAny] ?? [],
        loadouts,
        newItems
      ),
    [
      wishList,
      items,
      itemInfos,
      ratings,
      defs,
      customTotalStatsByClass,
      classIfAny,
      loadouts,
      newItems
    ]
  );

  // This needs work for sure
  const filteredColumns = _.compact(
    enabledColumns.flatMap((id) => columns.filter((column) => id === getColumnSelectionId(column)))
  );

  // process items into Rows
  const rows: Row[] = useMemo(() => {
    const unsortedRows: Row[] = items.map((item) => ({
      item,
      values: filteredColumns.reduce((memo, col) => {
        memo[col.id] = col.value(item);
        return memo;
      }, {})
    }));

    const comparator = chainComparator<Row>(
      ...columnSorts.map((sorter) => {
        const column = filteredColumns.find((c) => c.id === sorter.columnId);
        if (column) {
          const compare = column.sort
            ? (row1: Row, row2: Row) => column.sort!(row1.values[column.id], row2.values[column.id])
            : compareBy((row: Row) => row.values[column.id]);
          return sorter.sort === SortDirection.ASC ? compare : reverseComparator(compare);
        }
        return compareBy(() => 0);
      })
    );

    return unsortedRows.sort(comparator);
  }, [filteredColumns, items, columnSorts]);

  const shiftHeld = useShiftHeld();

  const onChangeEnabledColumn = useCallback(
    ({ checked, id }: { checked: boolean; id: string }) => {
      dispatch(
        setSetting(
          isArmor ? 'organizerColumnsArmor' : 'organizerColumnsWeapons',
          _.uniq(
            _.compact(
              columns.map((c) => {
                const cId = getColumnSelectionId(c);
                if (cId === id) {
                  return checked ? cId : undefined;
                } else {
                  return enabledColumns.includes(cId) ? cId : undefined;
                }
              })
            )
          )
        )
      );
    },
    [dispatch, columns, enabledColumns, isArmor]
  );
  // TODO: stolen from SearchFilter, should probably refactor into a shared thing
  const onLock = loadingTracker.trackPromise(async (lock: boolean) => {
    const selectedItems = items.filter((i) => selectedItemIds.includes(i.id));

    const state = lock;
    try {
      for (const item of selectedItems) {
        await setItemLockState(item, state);

        // TODO: Gotta do this differently in react land
        item.locked = lock;
      }
      showNotification({
        type: 'success',
        title: state
          ? t('Filter.LockAllSuccess', { num: selectedItems.length })
          : t('Filter.UnlockAllSuccess', { num: selectedItems.length })
      });
    } catch (e) {
      showNotification({
        type: 'error',
        title: state ? t('Filter.LockAllFailed') : t('Filter.UnlockAllFailed'),
        body: e.message
      });
    } finally {
      // Touch the stores service to update state
      if (selectedItems.length) {
        dispatch(touch());
      }
    }
  });

  const onNote = (note?: string) => {
    if (!note) {
      note = undefined;
    }
    if (selectedItemIds.length) {
      const selectedItems = items.filter((i) => selectedItemIds.includes(i.id));
      for (const item of selectedItems) {
        dispatch(setItemNote({ itemId: item.id, note }));
      }
    }
  };

  /**
   * When shift-clicking a value, if there's a filter function defined, narrow/un-narrow the search
   */
  const narrowQueryFunction = (
    row: Row,
    column: ColumnDefinition
  ): React.MouseEventHandler<HTMLTableDataCellElement> | undefined =>
    column.filter
      ? (e) => {
          if (e.shiftKey) {
            console.log(e, e.target, e.currentTarget);
            if ((e.target as Element).hasAttribute('data-perk-name')) {
              dispatch(
                toggleSearchQueryComponent(
                  column.filter!((e.target as Element).getAttribute('data-perk-name')!, row.item)
                )
              );
              return;
            }
            const filter = column.filter!(row.values[column.id], row.item);
            if (filter !== undefined) {
              dispatch(toggleSearchQueryComponent(filter));
            }
          }
        }
      : undefined;

  const onMoveSelectedItems = (store: DimStore) => {
    if (selectedItemIds.length) {
      const selectedItems = items.filter((i) => selectedItemIds.includes(i.id));
      const loadout = newLoadout(
        t('Organizer.BulkMoveLoadoutName'),
        selectedItems.map((i) => convertToLoadoutItem(i, false))
      );

      applyLoadout(store, loadout, true);
    }
  };

  const onTagSelectedItems = (tagInfo: TagInfo) => {
    if (tagInfo.type && selectedItemIds.length) {
      const selectedItems = items.filter((i) => selectedItemIds.includes(i.id));
      dispatch(bulkTagItems(selectedItems, tagInfo.type));
    }
  };

  const gridSpec = `min-content ${filteredColumns
    .map((c) => c.gridWidth ?? 'min-content')
    .join(' ')}`;

  /**
   * Toggle sorting of columns. If shift is held, adds this column to the sort.
   */
  const toggleColumnSort = (column: ColumnDefinition) => () => {
    setColumnSorts((sorts) => {
      const newColumnSorts = shiftHeld ? sorts : sorts.filter((s) => s.columnId === column.id);
      let found = false;
      let index = 0;
      for (const columnSort of newColumnSorts) {
        if (columnSort.columnId === column.id) {
          newColumnSorts[index] = {
            ...columnSort,
            sort: columnSort.sort === SortDirection.ASC ? SortDirection.DESC : SortDirection.ASC
          };
          found = true;
          break;
        }
        index++;
      }
      if (!found) {
        newColumnSorts.push({
          columnId: column.id,
          sort: column.defaultSort || SortDirection.ASC
        });
      }
      return newColumnSorts;
    });
  };

  /**
   * Select all items, or if any are selected, clear the selection.
   */
  const selectAllItems: React.ChangeEventHandler<HTMLInputElement> = () => {
    if (selectedItemIds.length === 0) {
      setSelectedItemIds(rows.map((r) => r.item.id));
    } else {
      setSelectedItemIds([]);
    }
  };

  /**
   * Select and unselect items. Supports shift-held range selection.
   */
  const selectItem = (e: React.ChangeEvent<HTMLInputElement>, item: DimItem) => {
    const checked = e.target.checked;

    let changingIds = [item.id];
    if (shiftHeld && lastSelectedId.current) {
      let startIndex = rows.findIndex((r) => r.item.id === lastSelectedId.current);
      let endIndex = rows.findIndex((r) => r.item === item);
      if (startIndex > endIndex) {
        const tmp = startIndex;
        startIndex = endIndex;
        endIndex = tmp;
      }
      changingIds = rows.slice(startIndex, endIndex + 1).map((r) => r.item.id);
    }

    if (checked) {
      setSelectedItemIds((selected) => _.uniq([...selected, ...changingIds]));
    } else {
      setSelectedItemIds((selected) => selected.filter((i) => !changingIds.includes(i)));
    }

    lastSelectedId.current = item.id;
  };

  // TODO: css grid, floating header
  return (
    <div
      className={clsx(styles.table, shiftHeld && styles.shiftHeld)}
      style={{ gridTemplateColumns: gridSpec }}
      role="table"
    >
      <div className={styles.toolbar}>
        <div>
          <ItemActions
            itemsAreSelected={Boolean(selectedItemIds.length)}
            onLock={onLock}
            onNote={onNote}
            stores={stores}
            onTagSelectedItems={onTagSelectedItems}
            onMoveSelectedItems={onMoveSelectedItems}
          />
          <EnabledColumnsSelector
            columns={columns}
            enabledColumns={enabledColumns}
            onChangeEnabledColumn={onChangeEnabledColumn}
            forClass={classIfAny}
          />
        </div>
      </div>
      <div className={clsx(styles.selection, styles.header)} role="columnheader" aria-sort="none">
        <input
          name="selectAll"
          title={t('Organizer.SelectAll')}
          type="checkbox"
          checked={selectedItemIds.length === rows.length}
          ref={(el) =>
            el &&
            (el.indeterminate =
              selectedItemIds.length !== rows.length && selectedItemIds.length > 0)
          }
          onChange={selectAllItems}
        />
      </div>
      {filteredColumns.map((column: ColumnDefinition) => (
        <div
          key={column.id}
          className={clsx(styles[column.id], styles.header)}
          role="columnheader"
          aria-sort="none"
        >
          <div onClick={column.noSort ? undefined : toggleColumnSort(column)}>
            {column.header}
            {!column.noSort && columnSorts.some((c) => c.columnId === column.id) && (
              <AppIcon
                className={styles.sorter}
                icon={
                  columnSorts.find((c) => c.columnId === column.id)!.sort === SortDirection.DESC
                    ? faCaretUp
                    : faCaretDown
                }
              />
            )}
          </div>
        </div>
      ))}
      {rows.length === 0 && <div className={styles.noItems}>{t('Organizer.NoItems')}</div>}
      {rows.map((row, i) => (
        // TODO: row component
        <React.Fragment key={row.item.id}>
          <div
            className={clsx(styles.selection, {
              [styles.alternateRow]: i % 2
            })}
            role="cell"
          >
            <input
              type="checkbox"
              title={t('Organizer.SelectItem', { name: row.item.name })}
              checked={selectedItemIds.includes(row.item.id)}
              onChange={(e) => selectItem(e, row.item)}
            />
          </div>
          {filteredColumns.map((column: ColumnDefinition) => (
            <div
              key={column.id}
              onClick={narrowQueryFunction(row, column)}
              className={clsx(styles[column.id], {
                [styles.hasFilter]: column.filter,
                [styles.alternateRow]: i % 2
              })}
              role="cell"
            >
              {column.cell ? column.cell(row.values[column.id], row.item) : row.values[column.id]}
            </div>
          ))}
        </React.Fragment>
      ))}
    </div>
  );
}

export default connect<StoreProps>(mapStateToProps)(ItemTable);
