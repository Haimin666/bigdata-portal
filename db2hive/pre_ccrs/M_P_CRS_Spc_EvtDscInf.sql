use lion_dw_ods;
  create table if not exists pre_ccrs_m_p_crs_spc_evtdscinf (
  `acctcode` string comment '账户标识码,默认值:Null' ,`data_source` string comment '数据来源,默认值:Null' ,`finorgcode` string comment '金融机构代码,默认值:Null' ,`opetntype` string comment '事件类型,默认值:Null' ,`month` string comment '发生月份,默认值:Null' ,`flag` string comment '生效标志,默认值:Null' ,`rptdate` string comment '信息报告日期,默认值:Null' ,`isallowpost` string comment 'CRS标识符,默认值:Null' ,`business_key` string comment '主键重复1否2是,默认值:Null' 
  ) 
  comment "个人借贷账户特殊事件说明记录"
  PARTITIONED BY(dt string)